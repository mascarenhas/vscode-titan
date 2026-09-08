#!/usr/bin/env python3
"""Compact a streamed analyze-spans result and separate native startup phases.

Reads analyzer JSON, never a live workload. The span array must use the
one-object-per-line output produced by analyze-spans.mjs. No clock interpolation
or wall-time proportional CPU attribution is performed.
"""
import argparse
from collections import Counter
import json
from pathlib import Path

METRICS = ("monotonic_ms", "process_cpu_ms", "thread_cpu_ms", "child_user_ms", "child_system_ms")
PIPELINE = ("project.scan", "compiler.attempt", "compiler.resolve_check",
            "compiler.module_normalization", "project.result_commit", "publication.view",
            "compiler.export_projects", "semantic.features_prepare", "publication.transaction",
            "semantic.features_publish", "publication.cache_write")


def zero():
    return dict.fromkeys(METRICS, 0.0)


def group(name):
    return {"name": name, "count": 0, "inclusive_sum": zero(), "residual_sum": zero(),
            "non_ancestral_overlap_sum_ms": 0.0}


def add(target, span):
    target["count"] += 1
    for metric in METRICS:
        for field in ("inclusive", "residual"):
            value = span[field][metric]
            if value is not None:
                target[field + "_sum"][metric] += value
    target["non_ancestral_overlap_sum_ms"] += span["non_ancestral_overlap_wall_ms"]


PHASES = (
    ("Workspace discovery and configuration", {"project.discovery", "project.configuration_load"}),
    ("Saved-source observation residual", {"project.source_observation"}),
    ("Header preprocessing", {"c_header.preprocessing", "c_header.preprocessor_concat"}),
    ("C parsing", {"c_header.c_parse"}),
    ("C type and macro conversion", {"c_header.c_type_conversion", "c_header.macro_conversion"}),
    ("Downstream FFI conversion", {"c_header.downstream_ffi_conversion"}),
    ("Source parsing", {"source.parse"}),
    ("Source checking residual", {"source.check"}),
    ("Redeclaration finalizer residual", {"ffi_redeclaration_finalization"}),
    ("Probe request construction and bookkeeping residual", {"probe_request", "probe_lookup", "probe_publication"}),
    ("Physical probe runner intervals", {"probe_runner"}),
    ("Compiler module normalization", {"compiler.module_normalization"}),
    ("Graph serialization", {"graph.encode", "graph.enumerate_pack", "graph.chunks", "graph.body_concat", "graph.checksum", "graph.envelope_concat"}),
    ("Project export validation and wrapper residual", {"project_cache.validate_encode", "project_cache.root_projection", "compiler.export_projects", "compiler.project_encode"}),
    ("SQLite argument-array construction", {"sqlite.arguments_construct"}),
    ("SQLite prepare API", {"sqlite.prepare_api"}),
    ("SQLite execute API", {"sqlite.execute_api"}),
    ("SQLite query and scalar-fetch APIs", {"sqlite.query_api", "sqlite.scalar_fetch_api"}),
    ("SQLite cursor iteration including row decoding", {"sqlite.cursor_iteration"}),
    ("SQLite commit API", {"sqlite.commit_api"}),
    ("SQLite statement-helper residual", {"sqlite.execute_statement", "sqlite.scalar_statement", "sqlite.rows_statement", "sqlite.semantic_statement"}),
    ("Semantic preparation", {"semantic.features_prepare", "semantic.occurrences_prepare", "semantic.inputs_prepare"}),
    ("Demand observation", {"ffi_demand_observation"}),
)


def phase_for(name):
    for label, names in PHASES:
        if name in names:
            return label
    if name.startswith("semantic."):
        return "Semantic publication wrapper residual"
    if name.startswith(("cache.", "publication.")):
        return "Cache/publication wrapper residual"
    if name.startswith("sqlite."):
        return "Other SQLite lifecycle APIs"
    if name.startswith("project."):
        return "Project graph and scan wrapper residual"
    if name.startswith("c_header."):
        return "Other header processing and cache residual"
    return "Other named residual"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("analysis", type=Path)
    parser.add_argument("--harness", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True, help="fresh summary JSON; sibling .md is also written")
    args = parser.parse_args()
    assert not args.out.exists() and not args.out.with_suffix(".md").exists(), "choose new output paths"
    with args.analysis.open() as stream:
        prefix = []
        for line in stream:
            if line.startswith('  "spans": ['):
                break
            prefix.append(line)
        else:
            raise ValueError("expected the streamed analyzer span array")
        summary = json.loads("".join(prefix) + '  "spans": []\n}\n')
        summary.pop("spans")
        assert summary["integrity"]["passed"], "resolve span integrity failures before native phase accounting"
        refresh = [item for item in summary["root_spans"] if item["name"] == "application.refresh_once"]
        assert len(refresh) == 1, "this summary requires exactly one native refresh"
        boundary = refresh[0]["finish"]
        partitions = {key: {} for key in ("startup", "post_refresh", "crossing_refresh_end")}
        ancestry, graph_spans, selected, post_spans = {}, [], [], []
        span_count = 0
        for line in stream:
            if line.strip() == "]":
                break
            item = json.loads(line.strip().removesuffix(","))
            span_count += 1
            name = item["name"]
            if name == "c_header.phase":
                name = "c_header." + item["fields"]["phase"]
            if item["finish"]["monotonic_ms"] <= boundary:
                partition = "startup"
            elif item["start"]["monotonic_ms"] >= boundary:
                partition = "post_refresh"
                post_spans.append(item)
            else:
                partition = "crossing_refresh_end"
            key = item["producer"] + ":" + name
            target = partitions[partition].setdefault(key, {"producer": item["producer"], **group(name)})
            add(target, item)
            ancestry[item["id"]] = (item["parent_id"], item["name"])
            if item["name"].startswith("graph."):
                graph_spans.append(item)
            if item["name"] in PIPELINE or item["name"].startswith("application."):
                selected.append(item)
        assert span_count == summary["complete_span_count"], "truncated or inconsistent span inventory"
        assert stream.read().strip() == "}", "unexpected data after span array"

    # Every category belongs to exactly one row. These are sums of direct-child
    # residuals, not globally exclusive Task CPU in the presence of overlap.
    rows = {}
    for category in partitions["startup"].values():
        label = phase_for(category["name"])
        row = rows.setdefault(label, {"phase": label, "span_count": 0, "residual_sum": zero(), "categories": []})
        row["categories"].append(category["producer"] + ":" + category["name"])
        row["span_count"] += category["count"]
        for metric in METRICS:
            row["residual_sum"][metric] += category["residual_sum"][metric]
    assert sum(row["span_count"] for row in rows.values()) == sum(c["count"] for c in partitions["startup"].values())
    graph_owners = {}
    for item in graph_spans:
        parent = item["parent_id"]
        owner = "unlinked graph scope"
        while parent:
            parent, name = ancestry[parent]
            if name in ("compiler.project_encode", "ffi_conversion_cache.encode", "c_header.cache_encode"):
                owner = name
                break
        target = graph_owners.setdefault(owner, {"encode_count": 0, "encoded_bytes": 0, "residual_sum": zero(), "phases": {}})
        phase = target["phases"].setdefault(item["name"], group(item["name"]))
        add(phase, item)
        if item["name"] == "graph.encode":
            target["encode_count"] += 1
            target["encoded_bytes"] += item["fields"].get("bytes", 0)
        for metric in METRICS:
            target["residual_sum"][metric] += item["residual"][metric] or 0

    harness = json.loads(args.harness.read_text())
    refresh_details = next(item for item in selected if item["name"] == "application.refresh_once")
    categories = {key: list(groups.values()) for key, groups in partitions.items()}
    summary["root_span_counts"] = dict(sorted(Counter(item["name"] for item in summary.pop("root_spans")).items()))
    summary["root_span_count"] = len(summary.pop("root_span_ids"))
    summary["native_analysis"] = {
        "startup_boundary": {"span": refresh_details, "meaning": "Refresh completion is a measured boundary before READY notification; it excludes later diagnostics reading, feature queries and shutdown."},
        "boundary_limit": "Client launch/initialized clocks and server monotonic clocks have different origins. Duration differences are available; no invented absolute READY timestamp or proportional CPU split is used.",
        "harness": {"complete": harness["complete"], "ready": harness["ready"], "after_queries": harness["afterQueries"],
                    "feature_wall_ms": {name: value["wallMs"] for name, value in harness["features"].items()},
                    "features_total_wall_ms": sum(value["wallMs"] for value in harness["features"].values())},
        "partitions": categories,
        "startup_phase_residuals": list(rows.values()),
        "startup_residual_sum": {metric: sum(row["residual_sum"][metric] for row in rows.values()) for metric in METRICS},
        "pipeline_spans": selected,
        "graph_serialization_by_owner": graph_owners,
        "post_refresh_compiler_span_count": sum(item["producer"] == "compiler" for item in post_spans),
        "overlap_limit": "Root-link gaps and independent Tasks can both create unrelated branches. Category residual sums can double-count overlapping work; global wall overlap is a union, while per-category overlap is a sum.",
        "runner_limit": "Probe runner wall spans include server spawn/drain/reap and any work during suspension. Process/thread CPU inside them is server CPU, not child GCC CPU.",
        "sql_limit": "Public SQLite API spans include marshaling, worker queueing, native execution and completion. Argument arrays are a separately observed subset; native bind/step/worker CPU are not independently measured.",
        "observer_limit": "Compiler and server overhead markers measure different partial producer costs. They exclude some sampling, metadata, GC and asynchronous writer work, and cannot be subtracted as a production speedup.",
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(summary, indent=2) + "\n")
    lines = ["# Native span accounting", "", f"Integrity: {'PASS' if summary['integrity']['passed'] else 'FAIL'}; {span_count:,} complete spans.", "",
             "Values are seconds. Residuals subtract directly linked child unions in each clock coordinate; rows are not a globally exclusive CPU partition.", "",
             "| Startup phase | Residual wall | Process CPU | Sampling-thread CPU | Reaped-child CPU |",
             "| --- | ---: | ---: | ---: | ---: |"]
    for row in rows.values():
        value = row["residual_sum"]
        lines.append(f"| {row['phase']} | {value['monotonic_ms']/1000:.3f} | {value['process_cpu_ms']/1000:.3f} | {value['thread_cpu_ms']/1000:.3f} | {(value['child_user_ms']+value['child_system_ms'])/1000:.3f} |")
    lines += ["", "## Inclusive pipeline windows", "", "These rows nest and must not be added to the residual table or to each other.", "",
              "| Window | Count | Wall | Process CPU | Sampling-thread CPU |", "| --- | ---: | ---: | ---: | ---: |"]
    for name in PIPELINE:
        category = partitions["startup"].get("server:" + name)
        if category:
            value = category["inclusive_sum"]
            lines.append(f"| {name} | {category['count']} | {value['monotonic_ms']/1000:.3f} | {value['process_cpu_ms']/1000:.3f} | {value['thread_cpu_ms']/1000:.3f} |")
    lines += ["", "## Limits", ""]
    lines.extend("- " + summary["native_analysis"][key] for key in ("boundary_limit", "overlap_limit", "runner_limit", "sql_limit", "observer_limit"))
    args.out.with_suffix(".md").write_text("\n".join(lines) + "\n")
    print(json.dumps({"summary": str(args.out), "integrity_passed": summary["integrity"]["passed"],
                      "complete_spans": span_count, "partition_counts": {name: sum(c["count"] for c in items) for name, items in categories.items()},
                      "post_refresh_compiler_spans": summary["native_analysis"]["post_refresh_compiler_span_count"]}, indent=2))


if __name__ == "__main__":
    main()
