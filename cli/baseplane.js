#!/usr/bin/env node
import path from "node:path";
import {
  compileGraph,
  readGraphFile,
  runPolicyTests,
  simulatePolicy,
  validateGraph,
  writeArtifacts
} from "../src/baseplane.js";

const args = process.argv.slice(2);
const command = args[0];

try {
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
  } else if (command === "validate") {
    const graph = readRequiredGraph();
    const result = validateGraph(graph);
    printValidation(result);
    process.exit(result.valid ? 0 : 1);
  } else if (command === "generate") {
    const graph = readRequiredGraph();
    const outDir = path.resolve(readOption("--out", "generated"));
    const artifacts = writeArtifacts(graph, outDir);
    console.log(`Generated ${Object.keys(artifacts).length} artifacts in ${outDir}`);
  } else if (command === "test-policies") {
    const graph = readRequiredGraph();
    const request = {
      principal_id: readOption("--principal"),
      action: readOption("--action"),
      resource_id: readOption("--resource"),
      field: readOption("--field")
    };

    if (request.principal_id && request.action && request.resource_id) {
      const result = simulatePolicy(graph, request);
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.effect === "allow" ? 0 : 2);
    }

    const results = runPolicyTests(graph);
    for (const item of results) {
      const marker = item.pass ? "PASS" : "FAIL";
      console.log(`${marker} ${item.name} -> ${item.actual} (${item.reason})`);
    }
    process.exit(results.every((item) => item.pass) ? 0 : 1);
  } else if (command === "compile") {
    const graph = readRequiredGraph();
    console.log(JSON.stringify(compileGraph(graph), null, 2));
  } else {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

function readRequiredGraph() {
  const file = readOption("--file");
  if (!file) {
    throw new Error("Missing --file path/to/baseplane.json");
  }
  return readGraphFile(file);
}

function readOption(name, fallback = undefined) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) return fallback;
  return value;
}

function printValidation(result) {
  if (result.valid) {
    console.log("Baseplane graph is valid.");
  } else {
    console.log("Baseplane graph is invalid.");
    for (const error of result.errors) console.log(`ERROR ${error}`);
  }
  for (const warning of result.warnings) console.log(`WARN ${warning}`);
}

function printHelp() {
  console.log(`Baseplane CLI

Usage:
  baseplane validate --file baseplane.json
  baseplane generate --file baseplane.json --out generated
  baseplane test-policies --file baseplane.json
  baseplane test-policies --file baseplane.json --principal analysis_agent --action read --resource telemetry_readings --field measurement_value

Current commands:
  validate       Check graph shape and references.
  generate       Compile graph into SQL, policy JSON, tests, and docs.
  test-policies  Run generated policy simulator tests or one explicit request.
  compile        Print generated artifacts as JSON.
`);
}
