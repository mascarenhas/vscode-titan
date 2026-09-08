"""Small, offline checks for demand relations and conservative attribution."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


TOOLS = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("demand_analysis", TOOLS / "analyze-demand.py")
ANALYZER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ANALYZER)


class Capture:
    def __init__(self, directory):
        self.directory = directory
        (directory / "sources").mkdir()
        self.events = []
        self.keys = []
        self.event("profile_start")
        for source in ("int first;\n", "int second;\n", "int baseline;\n", "int fourth;\n"):
            raw = source.encode()
            key = hashlib.sha256(raw).hexdigest()
            self.keys.append(key)
            (directory / "sources" / f"{key}.c").write_bytes(raw)
            self.event("source", key=key, path=f"sources/{key}.c", bytes=len(raw))
        scalar = self.type("Type.CInteger", "scalar")
        unseen = self.type("Type.CFunction", "unseen")
        primitive = self.type("Type.Integer", "primitive")
        for cid, name, typ, module in (
            ("c:A", "USED", scalar, "example"),
            ("c:B", "UNUSED_SHARED_SCALAR", scalar, "example"),
            ("c:C", "UNOBSERVED", unseen, "example"),
            ("c:D", "UNKNOWN", unseen, "missing-observer"),
            ("c:F", "USED_TYPE", primitive, "example"),
        ):
            self.event("candidate_queued", candidate_id=cid, module_name=module,
                       ordinary_name=name, previous_header="left.h", current_header="right.h",
                       purpose="foreign_redeclaration", left=typ, right=typ)
            self.event("foreign_name_inventory", candidate_id=cid, module_name=module,
                       header="right.h", ordinary_name=name, current=typ,
                       macro_definition_present=name == "USED",
                       category="type" if name == "USED_TYPE" else "value")
        self.request("r:A", "c:A", self.keys[0], "e:1")
        self.request("r:base", None, self.keys[2], "e:base", parent="r:A", purpose="header_baseline")
        self.request("r:B", "c:B", self.keys[0])
        self.request("r:C", "c:C", self.keys[0])
        self.request("r:A2", "c:A", self.keys[1], "e:2")
        self.request("r:op", None, self.keys[1], purpose="c_operator")
        self.request("r:D", "c:D", self.keys[3], "e:no", started=False)
        self.request("r:F", "c:F", self.keys[3])
        self.event("span_begin", name="ffi_demand_observation", span_id="s:demand",
                   fields={"module_name": "example"})
        self.event("demand_type", module_name="example", type=scalar, edges=[],
                   aggregate_fields_traversed=False)
        for did, name, role, typ, direct in (
            ("d:macro", "USED", "resolved_member", primitive, True),
            ("d:scalar", None, "annotated_syntax_type", scalar, False),
            ("d:type", "USED_TYPE", "resolved_foreign_type_name", primitive, True),
        ):
            self.event("demand_root", demand_id=did, module_name="example", role=role,
                       direct_foreign_use=direct, foreign_header="right.h" if direct else None,
                       ordinary_name=name, type=typ)
        self.event("span_end", name="ffi_demand_observation", span_id="s:demand",
                   fields={"module_name": "example", "roots": 3, "type_nodes": 1})

    @staticmethod
    def type(tag, name):
        return {"tag": tag, "type_id": f"type:{name}",
                "resolved_type_id": f"type:{name}", "resolved_tag": tag}

    def event(self, kind, **fields):
        self.events.append(dict(fields, event=kind))

    def request(self, rid, cid, key, eid=None, parent=None,
                purpose="foreign_redeclaration", started=True):
        fields = {"request_id": rid, "module_name": "example", "purpose": purpose, "probe_kind": purpose}
        if cid:
            fields["caller"] = {"candidate_id": cid, "purpose": purpose}
        if parent:
            fields["parent_request_id"] = parent
        self.event("request_start", **fields)
        self.event("request_source", request_id=rid, key=key)
        if eid:
            self.event("execution_start", execution_id=eid, request_id=rid, key=key)
            self.event("execution_result", execution_id=eid, request_id=rid, key=key,
                       started=started, outcome="success" if started else "infrastructure_failure",
                       wall_ms=3 if started else 0)
        result = {"request_id": rid, "key": key, "outcome": "success",
                  "resolution": "executed" if eid else "memory_hit"}
        if eid:
            result["execution_id"] = eid
        self.event("request_result", **result)

    def analyze(self, verify=True):
        events = self.events + [{"event": "profile_end", "complete": True}]
        with (self.directory / "events.jsonl").open("w") as stream:
            for sequence, event in enumerate(events, 1):
                row = dict(event, sequence=sequence, schema_version=1, producer="compiler")
                stream.write(json.dumps(row) + "\n")
        return ANALYZER.analyze(self.directory, verify)


class DemandAnalysisTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="titan-demand-test-")
        self.addCleanup(self.temporary.cleanup)
        self.capture = Capture(Path(self.temporary.name))

    def complete(self):
        report = self.capture.analyze()
        self.assertTrue(report["captureComplete"], report["anomalies"])
        return report

    def test_many_to_many_relations_and_single_execution_charge(self):
        report = self.complete()
        keys = {k["key"]: k for k in report["sourceKeys"]}
        self.assertEqual(keys[self.capture.keys[0]]["candidateIds"], {"c:A", "c:B", "c:C"})
        self.assertIn(["c:A", "r:A", "direct"], report["relations"]["candidateRequests"])
        self.assertIn(["c:A", "r:A2", "direct"], report["relations"]["candidateRequests"])
        self.assertIn(["r:A", self.capture.keys[0]], report["relations"]["requestKeys"])
        self.assertIn([self.capture.keys[0], "e:1"], report["relations"]["keyExecutions"])
        self.assertEqual(sum(g["executionRecords"] for g in report["costGroups"].values()), 4)
        self.assertEqual(sum(g["reportedChildWallMs"] for g in report["costGroups"].values()), 9)

    def test_baseline_parent_dependency_keeps_global_validity_cost(self):
        report = self.complete()
        baseline = next(k for k in report["sourceKeys"] if k["key"] == self.capture.keys[2])
        self.assertEqual(baseline["costGroup"], "global_header_validity")
        self.assertEqual(baseline["candidateIds"], {"c:A"})
        self.assertIn(["c:A", "r:base", "parent_request_dependency"], report["relations"]["candidateRequests"])

    def test_key_class_uses_all_candidate_and_unassociated_request_origins(self):
        report = self.complete()
        keys = {k["key"]: k for k in report["sourceKeys"]}
        for key in self.capture.keys[:2]:
            self.assertEqual(keys[key]["costGroup"], "direct_name_observed_shared_with_other_origins")
        self.assertEqual(keys[self.capture.keys[1]]["requestsWithoutCandidateRelation"], ["r:op"])
        self.assertTrue(all(c["safeToSkip"] is None for c in report["candidates"]))

    def test_shared_scalar_identity_is_not_name_demand(self):
        report = self.complete()
        candidates = {c["id"]: c for c in report["candidates"]}
        self.assertEqual(candidates["c:A"]["evidenceClass"], "exact_direct_resolved_name")
        self.assertEqual(candidates["c:B"]["evidenceClass"], "selected_type_identity_overlap_only")
        self.assertEqual(candidates["c:B"]["directDemandIds"], [])
        self.assertEqual(candidates["c:B"]["scalarTypeOverlapIds"], ["type:scalar"])

    def test_primitive_macro_and_foreign_type_names_keep_direct_evidence(self):
        report = self.complete()
        names = {n["ordinary_name"]: n for n in report["directResolvedNames"]}
        self.assertTrue(names["USED"]["macroDefinitionObserved"])
        self.assertTrue(names["USED"]["primitiveTitanTerminal"])
        self.assertEqual(names["USED_TYPE"]["roles"], ["resolved_foreign_type_name"])
        self.assertTrue(names["USED_TYPE"]["primitiveTitanTerminal"])
        candidate = next(c for c in report["candidates"] if c["id"] == "c:F")
        self.assertEqual(candidate["evidenceClass"], "exact_direct_resolved_name")

    def test_absence_requires_a_completed_module_observer(self):
        report = self.complete()
        candidates = {c["id"]: c for c in report["candidates"]}
        self.assertEqual(candidates["c:C"]["evidenceClass"], "not_observed_in_recorded_syntax_or_selected_types")
        self.assertEqual(candidates["c:D"]["evidenceClass"], "unknown_or_incomplete")
        self.assertFalse(report["modules"]["missing-observer"]["observerComplete"])

    def test_no_launch_unknown_launch_and_preparation_failure_stay_distinct(self):
        capture = self.capture
        capture.event("request_start", request_id="r:unknown", module_name="example", purpose="c_operator")
        capture.event("request_source", request_id="r:unknown", key=capture.keys[1])
        capture.event("execution_start", execution_id="e:unknown", request_id="r:unknown", key=capture.keys[1])
        capture.event("execution_result", execution_id="e:unknown", request_id="r:unknown", key=capture.keys[1],
                      execution_started_unknown=True, outcome="infrastructure_failure")
        capture.event("request_result", request_id="r:unknown", key=capture.keys[1],
                      execution_id="e:unknown", outcome="infrastructure_failure")
        capture.event("request_start", request_id="r:prepare", module_name="example", purpose="c_operator")
        capture.event("request_source", request_id="r:prepare", key=capture.keys[1])
        capture.event("execution_result", request_id="r:prepare", key=capture.keys[1],
                      preparation_failed=True, started=False, outcome="infrastructure_failure")
        capture.event("request_result", request_id="r:prepare", key=capture.keys[1], outcome="infrastructure_failure")
        report = self.complete()
        self.assertEqual(report["summary"]["physicalStartStates"], {"no": 1, "unknown": 1, "yes": 3})
        self.assertEqual(report["summary"]["preparationResultsWithoutExecutionId"], 1)
        unknown = next(e for e in report["executions"] if e["id"] == "e:unknown")
        self.assertIsNone(unknown["reportedChildWallMs"])
        self.assertIsNone(unknown["runnerIntervalWallMs"])

    def test_exact_source_hash_mismatch_invalidates_capture(self):
        self.assertTrue(self.complete()["sourceHashesVerified"])
        (self.capture.directory / "sources" / f"{self.capture.keys[0]}.c").write_text("changed\n")
        report = self.capture.analyze()
        self.assertFalse(report["captureComplete"])
        self.assertFalse(report["sourceHashesVerified"])
        self.assertTrue(any(a["kind"].startswith("source_artifact_") for a in report["anomalies"]))

    def test_unclosed_observer_invalidates_absence_but_preserves_direct_evidence(self):
        self.capture.events = [e for e in self.capture.events if not (
            e["event"] == "span_end" and e.get("name") == "ffi_demand_observation")]
        report = self.capture.analyze()
        candidates = {c["id"]: c for c in report["candidates"]}
        self.assertFalse(report["captureComplete"])
        self.assertEqual(candidates["c:C"]["evidenceClass"], "unknown_or_incomplete")
        self.assertEqual(candidates["c:A"]["evidenceClass"], "exact_direct_resolved_name")


if __name__ == "__main__":
    unittest.main()
