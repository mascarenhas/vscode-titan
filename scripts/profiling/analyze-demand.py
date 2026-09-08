#!/usr/bin/env python3
"""Analyze immutable Titan FFI profile evidence without executing compiler work.

Usage: python3 -E analyze-demand.py --trace /path/to/trace --output /tmp/demand.json
Writes JSON and a sibling Markdown report. Exact type identity overlap is evidence
of an observed type, never proof that an ordinary declaration name was demanded.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import math
from pathlib import Path
import re
import sys

KEY = re.compile(r"[0-9a-f]{64}\Z")
GLOBAL_PURPOSES = {"header_baseline"}
OPERATION_PURPOSES = {"enum_carrier", "enumerator_fit", "fam_extent", "c_operator", "unsafe_object_pointer"}
PRIMITIVE_TAGS = {"Type.Integer", "Type.Float", "Type.Boolean", "Type.String", "Type.Nil", "Type.Value"}
C_SCALAR_TAGS = {"Type.CInteger", "Type.CFloat", "Type.CVoid", "Type.CBool"}
CANDIDATE_EVENTS = {"candidate", "candidate_queued", "candidate_decision", "candidate_result"}


def obj(value):
    return value if isinstance(value, dict) else {}


def array(value):
    # The Lua emitter represents its empty arrays as {}.
    if value == {} or value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("expected an event array")
    return value


def strings(values):
    return sorted({v for v in values if isinstance(v, str) and v})


def type_ids(summary):
    summary = obj(summary)
    return set(strings([summary.get("type_id"), summary.get("resolved_type_id")]))


def slot(module, header, name):
    if all(isinstance(v, str) and v for v in (module, header, name)):
        return module, header, name
    return None


def scalar(value):
    return isinstance(value, (str, int, float, bool)) or value is None


def finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def compact_event(event, names):
    return {name: event[name] for name in names if name in event}


def counter(values):
    return dict(sorted(Counter(values).items()))


def analyze(trace: Path, verify_sources=False):
    counts = Counter()
    anomalies = []
    requests = {}
    candidates = {}
    executions = {}
    sources = {}
    contexts = {}
    inventory = []
    candidate_inventory = defaultdict(list)
    roots = []
    types = []
    selected_edges = []
    demand_completions = defaultdict(list)
    span_starts = {}
    profile_ends = []
    preparation_results = []
    last_sequence = 0
    event_digest = hashlib.sha256()

    def problem(kind, **details):
        anomalies.append({"kind": kind, **details})

    def request(rid):
        return requests.setdefault(rid, {"id": rid, "starts": [], "results": [],
            "sourceKeys": set(), "executionIds": set(), "directCandidateIds": set(),
            "parentRequestIds": set(), "renderedSequences": []})

    def candidate(cid):
        return candidates.setdefault(cid, {"id": cid, "observations": [],
            "eventKinds": set(), "resultStatuses": set(), "decisions": set(),
            "requestIds": set(), "inventorySequences": set()})

    def observe_candidate(cid, event, event_kind, module=None):
        if not isinstance(cid, str) or not cid:
            return
        value = candidate(cid)
        value["eventKinds"].add(event_kind)
        metadata = {k: v for k, v in event.items() if k not in
            {"sample", "schema_version", "producer", "event", "sequence", "parent_span_id"}}
        if module and not metadata.get("module_name"):
            metadata["module_name"] = module
        metadata.pop("candidate_id", None)
        if event_kind == "candidate_result":
            if event.get("status"):
                value["resultStatuses"].add(event["status"])
            return
        if event.get("decision"):
            value["decisions"].add(event["decision"])
        # Keep phase-specific identities if canonicalization changed a type.
        if not any(old["metadata"] == metadata for old in value["observations"]):
            value["observations"].append({"sequence": event.get("sequence"),
                "event": event_kind, "metadata": metadata})

    events_path = trace / "events.jsonl"
    with events_path.open("rb") as stream:
        for line_number, raw in enumerate(stream, 1):
            event_digest.update(raw)
            try:
                event = json.loads(raw, parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))
            except (ValueError, UnicodeDecodeError) as error:
                problem("invalid_json", line=line_number, error=str(error))
                continue
            if not isinstance(event, dict) or not isinstance(event.get("event"), str):
                problem("invalid_event", line=line_number)
                continue
            seq = event.get("sequence")
            if not isinstance(seq, int) or isinstance(seq, bool) or seq != last_sequence + 1:
                problem("noncontiguous_sequence", line=line_number, previous=last_sequence, sequence=seq)
            if isinstance(seq, int):
                last_sequence = seq
            if event.get("schema_version") != 1 or event.get("producer") != "compiler":
                problem("unexpected_schema_or_producer", line=line_number)
            kind = event["event"]
            counts[kind] += 1
            if kind == "profile_end":
                profile_ends.append(event)
            elif kind == "source":
                key = event.get("key")
                if not isinstance(key, str) or not KEY.fullmatch(key):
                    problem("invalid_source_key", sequence=seq, key=key)
                else:
                    if key in sources:
                        problem("duplicate_source", sequence=seq, key=key)
                    sources[key] = compact_event(event, ("key", "path", "bytes", "sequence"))
            elif kind == "context":
                contexts[event.get("context_id")] = obj(event.get("fields"))
            elif kind in CANDIDATE_EVENTS:
                observe_candidate(event.get("candidate_id"), event, kind)
            elif kind == "foreign_name_inventory":
                item = compact_event(event, ("sequence", "module_name", "header", "ordinary_name", "category",
                    "macro_definition_present", "current", "previous", "previous_header", "current_declaration",
                    "candidate_id", "decision", "import_id", "location"))
                inventory.append(item)
                cid = item.get("candidate_id")
                if cid:
                    candidate(cid)["inventorySequences"].add(seq)
                    candidate_inventory[cid].append(item)
            elif kind == "request_start":
                rid = event.get("request_id")
                if not isinstance(rid, str):
                    problem("missing_request_id", sequence=seq)
                    continue
                value = request(rid)
                value["starts"].append(compact_event(event, ("sequence", "module_name", "context_id", "purpose",
                    "probe_kind", "service_id", "parent_request_id", "caller")))
                caller = obj(event.get("caller"))
                cid = caller.get("candidate_id")
                if cid:
                    value["directCandidateIds"].add(cid)
                    enriched = dict(caller, sequence=seq)
                    observe_candidate(cid, enriched, "request_caller", event.get("module_name"))
                parent = event.get("parent_request_id")
                if parent:
                    value["parentRequestIds"].add(parent)
            elif kind == "request_source":
                rid, key = event.get("request_id"), event.get("key")
                if not isinstance(rid, str) or not isinstance(key, str) or not KEY.fullmatch(key):
                    problem("invalid_request_source", sequence=seq)
                else:
                    request(rid)["sourceKeys"].add(key)
            elif kind == "request_rendered":
                request(event.get("request_id"))["renderedSequences"].append(seq)
            elif kind == "request_result":
                value = request(event.get("request_id"))
                value["results"].append(compact_event(event, ("sequence", "key", "outcome", "reason", "cache_tier",
                    "cached", "interrupted", "status", "resolution", "execution_id", "returned_status",
                    "returned_accepted", "lookup", "publication")))
                if event.get("key"):
                    value["sourceKeys"].add(event["key"])
                if event.get("execution_id"):
                    value["executionIds"].add(event["execution_id"])
            elif kind in {"execution_start", "execution_result"}:
                eid = event.get("execution_id")
                if not eid:
                    preparation_results.append(compact_event(event, ("sequence", "request_id", "key", "outcome",
                        "preparation_failed", "started", "execution_started_unknown", "status", "reason")))
                    continue
                value = executions.setdefault(eid, {"id": eid, "starts": [], "results": [], "runnerSpans": []})
                fields = ("sequence", "request_id", "context_id", "purpose", "key", "stage", "started",
                    "execution_started_unknown", "outcome", "status", "interrupted", "wall_ms", "preparation_failed")
                value["starts" if kind == "execution_start" else "results"].append(compact_event(event, fields))
                if event.get("request_id"):
                    request(event["request_id"])["executionIds"].add(eid)
            elif kind == "demand_root":
                roots.append(compact_event(event, ("sequence", "module_name", "demand_id", "ast_tag", "role", "name",
                    "written_module", "location", "type", "member_name", "member_module", "member_id",
                    "direct_foreign_use", "foreign_header", "ordinary_name", "layout_closure")))
            elif kind == "demand_type":
                item = compact_event(event, ("sequence", "module_name", "type", "aggregate_fields_traversed"))
                item["edges"] = array(event.get("edges"))
                types.append(item)
                if event.get("aggregate_fields_traversed") is not False:
                    problem("unexpected_aggregate_traversal_policy", sequence=seq)
                for edge in item["edges"]:
                    selected_edges.append({"module_name": item.get("module_name"),
                        "source_type_id": obj(item.get("type")).get("type_id"), **edge, "sequence": seq})
            elif kind == "span_begin" and event.get("name") in {"probe_runner", "probe_request", "ffi_demand_observation"}:
                span_starts[event.get("span_id")] = event
            elif kind == "span_end" and event.get("name") in {"probe_runner", "probe_request", "ffi_demand_observation"}:
                start = span_starts.pop(event.get("span_id"), None)
                if start is None:
                    problem("span_end_without_begin", sequence=seq, span_id=event.get("span_id"))
                    continue
                fields = obj(event.get("fields"))
                if event["name"] == "ffi_demand_observation":
                    module = fields.get("module_name") or obj(start.get("fields")).get("module_name")
                    demand_completions[module].append({"beginSequence": start.get("sequence"), "endSequence": seq,
                        "fields": fields, "span_id": event.get("span_id")})
                elif event["name"] == "probe_runner":
                    eid = obj(start.get("fields")).get("execution_id")
                    if eid:
                        value = executions.setdefault(eid, {"id": eid, "starts": [], "results": [], "runnerSpans": []})
                        value["runnerSpans"].append(compact_event(event, ("span_id", "sequence", "start", "finish", "delta")))

    if counts["profile_start"] != 1 or len(profile_ends) != 1 or not profile_ends or profile_ends[-1].get("complete") is not True:
        problem("capture_not_complete", starts=counts["profile_start"], ends=len(profile_ends))
    if (trace / "INCOMPLETE").exists():
        problem("incomplete_marker_present")
    for sid, start in span_starts.items():
        problem("open_relevant_span", span_id=sid, name=start.get("name"))
    for rid, value in requests.items():
        if len(value["starts"]) != 1 or len(value["results"]) != 1:
            problem("request_pairing", request_id=rid, starts=len(value["starts"]), results=len(value["results"]))
        for key in value["sourceKeys"]:
            if not isinstance(key, str) or not KEY.fullmatch(key):
                problem("invalid_request_key", request_id=rid, key=key)
            elif key not in sources:
                problem("request_source_artifact_unrecorded", request_id=rid, key=key)
    for eid, value in executions.items():
        if len(value["starts"]) != 1 or len(value["results"]) != 1:
            problem("execution_pairing", execution_id=eid, starts=len(value["starts"]), results=len(value["results"]))
        keys = strings([e.get("key") for e in value["starts"] + value["results"]])
        if len(keys) != 1:
            problem("execution_key_not_unique", execution_id=eid, keys=keys)
        for key in keys:
            if key not in sources:
                problem("execution_source_unrecorded", execution_id=eid, key=key)
        value["keys"] = keys
        runner_durations = [obj(e.get("delta")).get("monotonic_ms") for e in value["runnerSpans"]]
        runner_durations = [duration for duration in runner_durations if finite_number(duration)]
        value["runnerIntervalWallMs"] = sum(runner_durations) if runner_durations else None
        durations = [e["wall_ms"] for e in value["results"] if finite_number(e.get("wall_ms"))]
        value["reportedChildWallMs"] = sum(durations) if durations else None
        states = [e.get("started") for e in value["results"]]
        value["physicalStart"] = "yes" if states == [True] else "no" if states == [False] else "unknown"

    if verify_sources:
        for key, source in sources.items():
            expected = f"sources/{key}.c"
            if source.get("path") != expected:
                problem("unexpected_source_artifact_path", key=key, path=source.get("path"))
                continue
            path = trace / expected
            if path.is_symlink() or not path.is_file():
                problem("source_artifact_missing_or_symlink", key=key)
                continue
            raw = path.read_bytes()
            if len(raw) != source.get("bytes") or hashlib.sha256(raw).hexdigest() != key:
                problem("source_artifact_identity_mismatch", key=key)

    by_module_roots = defaultdict(list)
    by_module_types = defaultdict(list)
    direct_slots = defaultdict(list)
    observed_ids = defaultdict(set)
    id_tags = defaultdict(set)
    for item in roots:
        module = item.get("module_name")
        by_module_roots[module].append(item)
        observed_ids[module].update(type_ids(item.get("type")))
        typ = obj(item.get("type"))
        for tid in type_ids(typ):
            id_tags[tid].update(strings([typ.get("tag"), typ.get("resolved_tag")]))
        if item.get("direct_foreign_use") is True:
            key = slot(module, item.get("foreign_header"), item.get("ordinary_name"))
            if key:
                direct_slots[key].append(item)
    for item in types:
        module = item.get("module_name")
        by_module_types[module].append(item)
        observed_ids[module].update(type_ids(item.get("type")))
        for edge in item["edges"]:
            if edge.get("type_id"):
                observed_ids[module].add(edge["type_id"])
        typ = obj(item.get("type"))
        for tid in type_ids(typ):
            id_tags[tid].update(strings([typ.get("tag"), typ.get("resolved_tag")]))
    observer_complete = {}
    modules = strings(list(by_module_roots) + list(by_module_types) + list(demand_completions) +
        [e.get("module_name") for e in inventory] +
        [e.get("module_name") for r in requests.values() for e in r["starts"]])
    for module in modules:
        endings = demand_completions[module]
        recorded_roots = sum(obj(e["fields"]).get("roots", 0) for e in endings)
        recorded_types = sum(obj(e["fields"]).get("type_nodes", 0) for e in endings)
        normal = endings and all("roots" in e["fields"] and "type_nodes" in e["fields"] and
            e["fields"].get("scope_exit") != "error" for e in endings)
        observer_complete[module] = bool(normal and recorded_roots == len(by_module_roots[module]) and
            recorded_types == len(by_module_types[module]))
        if endings and not observer_complete[module]:
            problem("demand_observer_count_or_completion_mismatch", module=module)

    inventory_slots = defaultdict(list)
    exact_inventory_edges = []
    for item in inventory:
        key = slot(item.get("module_name"), item.get("header"), item.get("ordinary_name"))
        if key:
            inventory_slots[key].append(item)
        matches = direct_slots.get(key, [])
        item["directDemandIds"] = strings([e.get("demand_id") for e in matches])
        item["typeOverlapIds"] = sorted(type_ids(item.get("current")) & observed_ids[item.get("module_name")])
        for match in matches:
            exact_inventory_edges.append([match.get("demand_id"), item.get("sequence")])

    inherited = {}
    def related_candidates(rid, active=None):
        if rid in inherited:
            return inherited[rid]
        active = set() if active is None else active
        if rid in active:
            problem("request_parent_cycle", request_id=rid)
            return set()
        if rid not in requests:
            problem("missing_parent_request", request_id=rid)
            return set()
        value = requests[rid]
        result = set(value["directCandidateIds"])
        for parent in value["parentRequestIds"]:
            result.update(related_candidates(parent, active | {rid}))
        inherited[rid] = result
        return result

    candidate_request_edges = []
    request_parent_edges = []
    request_key_edges = []
    request_execution_edges = []
    key_records = {key: {**source, "requestIds": set(), "candidateIds": set(), "executionIds": set(),
        "purposes": set(), "moduleNames": set()} for key, source in sources.items()}
    for rid, value in requests.items():
        linked = related_candidates(rid)
        for cid in linked:
            candidate(cid)["requestIds"].add(rid)
            candidate_request_edges.append([cid, rid, "direct" if cid in value["directCandidateIds"] else "parent_request_dependency"])
        for parent in value["parentRequestIds"]:
            request_parent_edges.append([rid, parent])
        for key in value["sourceKeys"]:
            request_key_edges.append([rid, key])
            entry = key_records.setdefault(key, {"key": key, "requestIds": set(), "candidateIds": set(),
                "executionIds": set(), "purposes": set(), "moduleNames": set()})
            entry["requestIds"].add(rid)
            entry["candidateIds"].update(linked)
            entry["purposes"].update(strings([e.get("purpose") for e in value["starts"]]))
            entry["moduleNames"].update(strings([e.get("module_name") for e in value["starts"]]))
        for eid in value["executionIds"]:
            request_execution_edges.append([rid, eid])
            if eid not in executions:
                problem("missing_execution", request_id=rid, execution_id=eid)

    capture_complete = not anomalies
    candidate_direct_edges = []
    for cid, value in candidates.items():
        metas = [e["metadata"] for e in value["observations"]]
        candidate_slots = set()
        ids_by_module = defaultdict(set)
        for meta in metas:
            module, name = meta.get("module_name"), meta.get("ordinary_name")
            for header in (meta.get("previous_header"), meta.get("current_header")):
                key = slot(module, header, name)
                if key:
                    candidate_slots.add(key)
            for side in ("left", "right", "current", "previous"):
                ids_by_module[module].update(type_ids(meta.get(side)))
        # An inventory event ties a queued candidate to this exact import slot.
        for entry in candidate_inventory[cid]:
            key = slot(entry.get("module_name"), entry.get("header"), entry.get("ordinary_name"))
            if key:
                candidate_slots.add(key)
            ids_by_module[entry.get("module_name")].update(type_ids(entry.get("current")))
            ids_by_module[entry.get("module_name")].update(type_ids(entry.get("previous")))
        direct = strings([root.get("demand_id") for key in candidate_slots for root in direct_slots.get(key, [])])
        overlaps = set()
        for module, ids in ids_by_module.items():
            overlaps.update(ids & observed_ids[module])
        own_modules = strings([m.get("module_name") for m in metas] + [k[0] for k in candidate_slots])
        purposes = strings([m.get("purpose") for m in metas])
        has_observer = bool(own_modules) and all(observer_complete.get(m, False) for m in own_modules)
        evidence = "unknown_or_incomplete"
        if direct:
            evidence = "exact_direct_resolved_name"
        elif overlaps:
            evidence = "selected_type_identity_overlap_only"
        elif capture_complete and has_observer and candidate_slots:
            evidence = "not_observed_in_recorded_syntax_or_selected_types"
        if set(purposes) & OPERATION_PURPOSES and not candidate_slots:
            evidence = "operation_predicate_postcheck_relation_unknown"
        value.update({"ordinarySlots": [list(k) for k in sorted(candidate_slots)], "moduleNames": own_modules,
            "purposes": purposes, "directDemandIds": direct, "typeOverlapIds": sorted(overlaps),
            "scalarTypeOverlapIds": sorted(tid for tid in overlaps if id_tags[tid] & (PRIMITIVE_TAGS | C_SCALAR_TAGS)),
            "observerCompletedForModules": has_observer, "evidenceClass": evidence,
            "safeToSkip": None, "layoutOrGlobalValidityClosure": "unknown"})
        for demand in direct:
            candidate_direct_edges.append([cid, demand])

    key_execution_edges = []
    for eid, value in executions.items():
        for key in value["keys"]:
            if key not in key_records:
                continue
            key_records[key]["executionIds"].add(eid)
            key_execution_edges.append([key, eid])
    cost_groups = defaultdict(lambda: {"keys": 0, "executionRecords": 0, "physicalStarted": 0,
        "physicalNotStarted": 0, "physicalStartUnknown": 0, "reportedChildWallMs": 0.0,
        "reportedChildWallAvailable": 0, "runnerIntervalWallAvailable": 0, "runnerIntervalWallMs": 0.0})
    for key, value in key_records.items():
        classes = {candidates[c]["evidenceClass"] for c in value["candidateIds"]}
        value["requestsWithoutCandidateRelation"] = strings(
            [rid for rid in value["requestIds"] if not inherited.get(rid)])
        if value["purposes"] & GLOBAL_PURPOSES:
            group = "global_header_validity"
        elif not value["requestIds"]:
            group = "captured_but_unrequested_source"
        elif "exact_direct_resolved_name" in classes:
            group = "direct_name_observed_shared_with_other_origins" if (
                len(classes) > 1 or value["requestsWithoutCandidateRelation"]) else "direct_names_observed"
        elif "selected_type_identity_overlap_only" in classes:
            group = "selected_type_overlap_without_direct_name"
        elif classes == {"not_observed_in_recorded_syntax_or_selected_types"} and not value["requestsWithoutCandidateRelation"]:
            group = "not_observed_by_completed_observer"
        elif value["purposes"] & OPERATION_PURPOSES:
            group = "operation_predicate_or_conversion"
        else:
            group = "unknown_or_incomplete"
        value["evidenceClasses"] = sorted(classes)
        value["costGroup"] = group
        value["safeToSkip"] = None
        bucket = cost_groups[group]
        bucket["keys"] += 1
        value["reportedChildWallMs"] = 0.0
        value["reportedChildWallAvailable"] = 0
        value["runnerIntervalWallMs"] = 0.0
        value["runnerIntervalWallAvailable"] = 0
        value["physicalStarted"] = 0
        for eid in value["executionIds"]:
            execution = executions[eid]
            bucket["executionRecords"] += 1
            label = {"yes": "physicalStarted", "no": "physicalNotStarted", "unknown": "physicalStartUnknown"}[execution["physicalStart"]]
            bucket[label] += 1
            value["physicalStarted"] += execution["physicalStart"] == "yes"
            wall = execution["reportedChildWallMs"]
            if wall is not None:
                bucket["reportedChildWallAvailable"] += 1
                bucket["reportedChildWallMs"] += wall
                value["reportedChildWallMs"] += wall
                value["reportedChildWallAvailable"] += 1
            runner_wall = execution["runnerIntervalWallMs"]
            if runner_wall is not None:
                bucket["runnerIntervalWallAvailable"] += 1
                bucket["runnerIntervalWallMs"] += runner_wall
                value["runnerIntervalWallAvailable"] += 1
                value["runnerIntervalWallMs"] += runner_wall
        if value["executionIds"] and not value["reportedChildWallAvailable"]:
            value["reportedChildWallMs"] = None
        if value["executionIds"] and not value["runnerIntervalWallAvailable"]:
            value["runnerIntervalWallMs"] = None
    for bucket in cost_groups.values():
        if bucket["executionRecords"] and not bucket["reportedChildWallAvailable"]:
            bucket["reportedChildWallMs"] = None
        if bucket["executionRecords"] and not bucket["runnerIntervalWallAvailable"]:
            bucket["runnerIntervalWallMs"] = None

    direct_name_report = []
    for key, matches in sorted(direct_slots.items()):
        entries = inventory_slots.get(key, [])
        tags = strings([obj(e.get("type")).get("tag") for e in matches])
        direct_name_report.append({"module_name": key[0], "header": key[1], "ordinary_name": key[2],
            "demandIds": strings([e.get("demand_id") for e in matches]),
            "inventorySequences": sorted(e["sequence"] for e in entries),
            "inventoryMatched": bool(entries),
            "macroDefinitionObserved": any(e.get("macro_definition_present") is True for e in entries),
            "primitiveTitanTerminal": any(t in PRIMITIVE_TAGS for t in tags), "typeTags": tags,
            "roles": strings([e.get("role") for e in matches]),
            "locations": [e.get("location") for e in matches]})

    module_report = {}
    for module in modules:
        rows = [e for e in inventory if e.get("module_name") == module]
        demand_names = [e for e in direct_name_report if e["module_name"] == module]
        local_candidates = [v for v in candidates.values() if module in v["moduleNames"]]
        module_report[module] = {"inventoryRows": len(rows),
            "inventoryDistinctSlots": len({slot(module, e.get("header"), e.get("ordinary_name")) for e in rows}),
            "inventoryMacroRows": sum(e.get("macro_definition_present") is True for e in rows),
            "demandRoots": len(by_module_roots[module]), "observedCTypeRecords": len(by_module_types[module]),
            "directResolvedNameSlots": len(demand_names),
            "directMacroNameSlots": sum(e["macroDefinitionObserved"] for e in demand_names),
            "directPrimitiveTitanTerminalSlots": sum(e["primitiveTitanTerminal"] for e in demand_names),
            "unmatchedDirectNameSlots": sum(not e["inventoryMatched"] for e in demand_names),
            "observerComplete": observer_complete.get(module, False),
            "observerCompletions": demand_completions[module],
            "candidateClasses": counter(v["evidenceClass"] for v in local_candidates)}

    report = {"schemaVersion": 1, "trace": str(trace), "eventsSha256": event_digest.hexdigest(),
        "captureComplete": not anomalies, "anomalies": anomalies,
        "sourceHashesVerified": (not any(e["kind"].startswith(("source_artifact_", "unexpected_source_artifact_"))
            for e in anomalies)) if verify_sources else None,
        "eventCounts": dict(sorted(counts.items())), "summary": {"candidates": len(candidates),
            "requests": len(requests), "sourceKeys": len(sources), "executionRecords": len(executions),
            "physicalStartStates": counter(v["physicalStart"] for v in executions.values()),
            "preparationResultsWithoutExecutionId": len(preparation_results), "inventoryRows": len(inventory),
            "demandRoots": len(roots), "directResolvedNameSlots": len(direct_name_report),
            "candidateClasses": counter(v["evidenceClass"] for v in candidates.values())},
        "costGroups": dict(sorted(cost_groups.items())), "modules": module_report,
        "directResolvedNames": direct_name_report, "candidates": sorted(candidates.values(), key=lambda x: x["id"]),
        "requests": sorted(requests.values(), key=lambda x: x["id"] or ""),
        "sourceKeys": sorted(key_records.values(), key=lambda x: x["key"]),
        "executions": sorted(executions.values(), key=lambda x: x["id"]),
        "preparationResultsWithoutExecutionId": preparation_results, "contexts": contexts,
        "inventory": inventory, "demandRoots": roots, "demandTypes": types,
        "selectedSignatureEdges": selected_edges,
        "relations": {"candidateRequests": sorted(candidate_request_edges),
            "requestParents": sorted(request_parent_edges), "requestKeys": sorted(request_key_edges),
            "requestExecutions": sorted(request_execution_edges), "keyExecutions": sorted(key_execution_edges),
            "directNamesToInventory": sorted(exact_inventory_edges), "candidateDirectDemands": sorted(candidate_direct_edges)},
        "limitations": [
            "Exact direct-use joins require the same literal module/header/ordinary-name slot; no spelling normalization is inferred.",
            "Selected type-ID overlap is not ordinary-name demand; shared scalar identities can overlap many unrelated declarations.",
            "The observer follows selected C signatures, typedefs, pointers, arrays and fields, and explicitly excludes aggregate field closure.",
            "Unobserved means absent from this completed observer, not unused or semantically safe to omit. Layout, numeric constraints and global header validity remain separate questions.",
            "Key cost classification uses all related candidates and requests, including inherited baseline dependencies; no cost is assigned only to the first requester.",
            "Each execution is counted once per validated source key. Reported child wall and enclosing runner wall are separate inclusive measurements; neither is inferred savings.",
            "PhysicalStart=yes requires execution_result.started=true; preparation failures without execution IDs and unknown start states remain separate.",
            "This report performs no compiler work, source edits, cache mutation or probe elimination."]}
    return report


def json_default(value):
    if isinstance(value, set):
        return sorted(value)
    raise TypeError(type(value).__name__)


def markdown(report):
    s = report["summary"]
    lines = ["# Titan FFI observed demand", "", f"Capture complete: **{str(report['captureComplete']).lower()}**. "
        f"{s['candidates']:,} candidates, {s['requests']:,} requests, {s['sourceKeys']:,} source keys, "
        f"{s['executionRecords']:,} execution records. This is observation evidence, not a skippability or speedup estimate.", "",
        "The full JSON retains many-to-many candidate/request/key/execution links and exact evidence sequences.", "",
        "| Module | Inventory rows | Direct resolved name slots | Direct macro slots | Demand roots | Observed C types | Observer complete |",
        "| --- | ---: | ---: | ---: | ---: | ---: | --- |"]
    for module, value in report["modules"].items():
        lines.append(f"| `{module}` | {value['inventoryRows']:,} | {value['directResolvedNameSlots']:,} | "
            f"{value['directMacroNameSlots']:,} | {value['demandRoots']:,} | {value['observedCTypeRecords']:,} | {value['observerComplete']} |")
    lines += ["", "| Candidate evidence | Count |", "| --- | ---: |"]
    for name, count in s["candidateClasses"].items():
        lines.append(f"| `{name}` | {count:,} |")
    lines += ["", "Physical costs use every association for each key. Shared keys are never assigned only to the first requester.", "",
        "| Key group | Keys | Started executions | Unknown start | Reported child wall ms | Runner interval wall ms |",
        "| --- | ---: | ---: | ---: | ---: | ---: |"]
    for name, value in report["costGroups"].items():
        wall = f"{value['reportedChildWallMs']:.3f}" if value["reportedChildWallAvailable"] else "unavailable"
        runner_wall = f"{value['runnerIntervalWallMs']:.3f}" if value["runnerIntervalWallAvailable"] else "unavailable"
        lines.append(f"| `{name}` | {value['keys']:,} | {value['physicalStarted']:,} | {value['physicalStartUnknown']:,} | {wall} | {runner_wall} |")
    lines += ["", "## Direct resolved ordinary names", "",
        "These are literal module/header/name slots selected by checked syntax, including foreign macros whose terminal type is a Titan primitive. A type identity match alone never appears in this list.", "",
        "| Module | Header | Name | Macro in inventory | Primitive Titan terminal | Inventory matched |",
        "| --- | --- | --- | --- | --- | --- |"]
    for item in report["directResolvedNames"]:
        lines.append(f"| `{item['module_name']}` | `{item['header']}` | `{item['ordinary_name']}` | "
            f"{item['macroDefinitionObserved']} | {item['primitiveTitanTerminal']} | {item['inventoryMatched']} |")
    if report["anomalies"]:
        lines += ["", "## Capture or relation anomalies", ""]
        lines.extend("- `" + json.dumps(item, sort_keys=True) + "`" for item in report["anomalies"])
    lines += ["", "## Limits", ""]
    lines.extend("- " + item for item in report["limitations"])
    return "\n".join(lines) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--trace", required=True, type=Path, help="immutable capture directory containing events.jsonl")
    parser.add_argument("--output", required=True, type=Path, help="JSON output outside the capture; a sibling .md is also written")
    parser.add_argument("--verify-sources", action="store_true", help="also read retained sources and verify recorded SHA-256/byte lengths")
    args = parser.parse_args(argv)
    trace = args.trace.resolve()
    output = args.output.resolve()
    if output.suffix != ".json":
        parser.error("--output must end in .json")
    if output.is_relative_to(trace):
        parser.error("write analysis outside the immutable capture directory")
    report = analyze(trace, args.verify_sources)
    output.write_text(json.dumps(report, indent=2, sort_keys=True, default=json_default, allow_nan=False) + "\n")
    output.with_suffix(".md").write_text(markdown(report))
    print(json.dumps({"captureComplete": report["captureComplete"], "summary": report["summary"],
        "output": str(output), "anomalies": len(report["anomalies"])}))
    return 0 if report["captureComplete"] else 2


if __name__ == "__main__":
    sys.exit(main())
