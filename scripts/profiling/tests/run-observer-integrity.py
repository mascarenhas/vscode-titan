#!/usr/bin/env python3
"""Compare profiling off/on with fake probe runners and explicit overlay paths.

Requires the prepared experimental compiler overlay, installed Lua 5.5 SDK,
and prebuilt clock module. Never invokes a C compiler or builds a dependency.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile


HERE = Path(__file__).resolve().parent
TOOLS = HERE.parent


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, TOOLS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(args, output):
    sdk, compiler, clock = args.sdk.resolve(), args.compiler.resolve(), args.clock_dir.resolve()
    lua = args.lua.resolve() if args.lua else sdk / "bin/lua"
    assert lua.is_file(), f"Lua executable missing: {lua}"
    assert (compiler / "titan-compiler/probeprofile.lua").is_file(), "apply the compiler observer patch first"
    assert (clock / "probe_profile_clock.so").is_file(), "build the separate clock module first"
    fixture = HERE / "observer-integrity.lua"
    expected = HERE / "fixtures/observer-integrity-v3/profile-off.stdout"
    results = {}
    for mode in ("off", "on"):
        work = output / mode
        work.mkdir()
        env = dict(os.environ)
        for name in ("TITAN_FFI_PROFILE_DIR", "TITAN_PROBE_CACHE_DISABLE", "TITAN_PROBE_CACHE_IDENTITY"):
            env.pop(name, None)
        env.update({
            "TITAN_PREFIX": str(work / "probe-prefix"), "TITAN_ROCKS_ROOT": str(sdk),
            "CC": "/usr/bin/cc", "CCACHE_DISABLE": "1", "PATH": f"{sdk}/bin:/usr/bin:/bin",
            "LUA_PATH": f"{compiler}/?.lua;{compiler}/?/init.lua;{sdk}/share/lua/5.5/?.lua;{sdk}/share/lua/5.5/?/init.lua",
            "LUA_CPATH": f"{clock}/?.so;{sdk}/lib/lua/5.5/?.so",
        })
        if mode == "on":
            env["TITAN_FFI_PROFILE_DIR"] = str(work / "capture")
        process = subprocess.run([str(lua), str(fixture), mode, str(work / "cache")],
                                 cwd=compiler, env=env, capture_output=True, timeout=60)
        (work / "stdout").write_bytes(process.stdout)
        (work / "stderr").write_bytes(process.stderr)
        assert process.returncode == 0, f"{mode} failed; inspect {work / 'stderr'}"
        results[mode] = process.stdout
    assert results["off"] == results["on"], "profiling changed source/key/status/cache/runner-count output"
    assert results["off"] == expected.read_bytes(), "observable results changed from the pinned suffix3 fixture"
    assert not (output / "off/capture").exists(), "disabled profiling created a capture"
    lines = [line.split("\t") for line in results["off"].decode().splitlines()]
    physical = [line for line in lines if line[0] == "physical-source"]
    assert len(physical) == 9 and all(line[3] == line[4] for line in physical)
    assert [line for line in lines if line[0] == "cancellation-identity-preserved"] == [
        ["cancellation-identity-preserved", "false", "true", "9"]]

    capture = output / "on/capture"
    probe = load("probe_analysis", "analyze-probes.py").analyze(capture)
    assert not probe["integrity_errors"], probe["integrity_errors"]
    assert (probe["request_count"], probe["source_count"], probe["execution_attempts"],
            probe["physical_started"], probe["physical_started_unknown"]) == (18, 3, 9, 7, 1)
    demand = load("demand_analysis", "analyze-demand.py").analyze(capture, True)
    assert demand["captureComplete"] and demand["sourceHashesVerified"], demand["anomalies"]
    assert demand["summary"]["physicalStartStates"] == {"no": 1, "unknown": 1, "yes": 7}
    assert demand["summary"]["preparationResultsWithoutExecutionId"] == 1
    direct = {row["ordinary_name"]: row for row in demand["directResolvedNames"]}
    assert set(direct) == {"USED_MACRO", "alias"}
    assert all(row["primitiveTitanTerminal"] for row in direct.values())
    assert all(row["type"].get("spelling") != "UNUSED_FAKE_NAME" for row in demand["demandTypes"])
    wrapper_bytes = {path.read_bytes() for path in (capture / "wrappers").glob("*.h")}
    assert wrapper_bytes == {b'#include "first.h"\n', b'#include "second.h"\n'}
    summary = {
        "passed": True, "workload": "fake runners only; simulated launch states are not real C compiler invocations",
        "profilingOffOnIdentical": True, "pinnedSuffix3OutputIdentical": True,
        "fixtureSha256": digest(fixture), "expectedOutputSha256": digest(expected),
        "compilerOverlay": str(compiler), "sdk": str(sdk), "lua": str(lua),
        "clockSha256": digest(clock / "probe_profile_clock.so"),
        "requests": probe["request_count"], "sourceKeys": probe["source_count"],
        "runnerAttempts": probe["execution_attempts"],
        "simulatedLaunchStates": demand["summary"]["physicalStartStates"],
        "preparationFailuresWithoutExecutionId": demand["summary"]["preparationResultsWithoutExecutionId"],
        "sourceHashesVerified": True, "wrapperVariantsPreserved": True,
    }
    (output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--compiler", required=True, type=Path, help="complete patched Titan source overlay")
    parser.add_argument("--sdk", required=True, type=Path, help="matching installed uninstrumented Lua/Titan SDK")
    parser.add_argument("--clock-dir", required=True, type=Path, help="directory containing prebuilt probe_profile_clock.so")
    parser.add_argument("--lua", type=Path, help="Lua 5.5 executable; defaults to SDK/bin/lua")
    parser.add_argument("--output", type=Path, help="new output directory to retain evidence; otherwise temporary")
    args = parser.parse_args()
    if args.output:
        output = args.output.resolve()
        output.mkdir(parents=True, exist_ok=False)
        run(args, output)
    else:
        with tempfile.TemporaryDirectory(prefix="titan-observer-integrity-") as temporary:
            run(args, Path(temporary))


if __name__ == "__main__":
    main()
