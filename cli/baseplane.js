#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  compileGraph,
  evaluateAccess,
  introspectSql,
  runPolicyTests,
  validateGraph
} from "../packages/compiler/index.js";

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
    const artifacts = compileGraph(graph);
    fs.mkdirSync(outDir, { recursive: true });
    for (const [name, content] of Object.entries(artifacts)) {
      fs.writeFileSync(path.join(outDir, name), content);
    }
    console.log(`Generated ${Object.keys(artifacts).length} artifacts in ${outDir}`);
  } else if (command === "test-policies") {
    const graph = readRequiredGraph();
    const explicit = {
      principal_id: readOption("--principal"),
      action: readOption("--action"),
      resource_id: readOption("--resource"),
      field: readOption("--field", "")
    };

    if (explicit.principal_id && explicit.action && explicit.resource_id) {
      const result = evaluateAccess(graph, explicit);
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.decision === "ALLOW" ? 0 : 2);
    }

    const results = runPolicyTests(graph);
    for (const item of results) {
      const marker = item.pass ? "PASS" : "FAIL";
      console.log(`${marker} ${item.name} -> ${item.actual} (${item.reason.join("; ")})`);
    }
    process.exit(results.every((item) => item.pass) ? 0 : 1);
  } else if (command === "diff") {
    readRequiredGraph();
    console.log("Diff is a safe placeholder in this alpha. It will compare baseplane.json to a target schema in a future release.");
  } else if (command === "apply") {
    const dryRun = args.includes("--dry-run");
    readRequiredGraph();
    if (!dryRun) {
      throw new Error("Destructive apply is intentionally disabled. Use: baseplane apply --dry-run <baseplane.json>");
    }
    console.log("Dry run only. No credentials read. No database touched. Generated artifacts can be reviewed with `baseplane generate`.");
  } else if (command === "introspect") {
    if (args.includes("--help") || args.includes("-h")) {
      printIntrospectHelp();
    } else {
      const schemaFile = readOption("--schema");
      const databaseUrl = readOption("--database-url");
      if (databaseUrl && !schemaFile) {
        throw new Error("Direct database introspection is not enabled in this alpha. Export schema SQL locally, then run: baseplane introspect --schema ./schema.sql");
      }
      if (!schemaFile) throw new Error("Missing --schema ./schema.sql");
      const graph = introspectSql(fs.readFileSync(path.resolve(schemaFile), "utf8"), {
        appName: readOption("--app-name", "Introspected Backend")
      });
      const output = `${JSON.stringify(graph, null, 2)}\n`;
      const outFile = readOption("--out");
      if (outFile) {
        fs.writeFileSync(path.resolve(outFile), output);
        console.log(`Wrote ${outFile}`);
      } else {
        console.log(output);
      }
    }
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
  const file = readGraphPath();
  if (!file) throw new Error("Missing baseplane.json path");
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

function readGraphPath() {
  const fileFlag = readOption("--file");
  if (fileFlag) return fileFlag;
  const positional = args.slice(1).find((item) => !item.startsWith("--"));
  return positional;
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
  baseplane validate ./baseplane.json
  baseplane generate ./baseplane.json --out ./out
  baseplane test-policies ./baseplane.json
  baseplane test-policies ./baseplane.json --principal analysis_agent --action read --resource telemetry_readings --field measurement_value
  baseplane diff ./baseplane.json
  baseplane apply --dry-run ./baseplane.json
  baseplane introspect --schema ./schema.sql --out ./baseplane.json

Commands:
  validate       Check graph shape and references.
  generate       Compile graph into SQL, route contracts, agent policy, tests, and docs.
  test-policies  Run generated policy simulator tests or one explicit request.
  diff           Safe placeholder.
  apply          Dry-run placeholder only.
  introspect     Convert local SQL schema into a starting graph.
  compile        Print generated artifacts as JSON.
`);
}

function printIntrospectHelp() {
  console.log(`Baseplane introspect

Usage:
  baseplane introspect --schema ./schema.sql --out ./baseplane.json
  baseplane introspect --schema ./schema.sql --app-name "My App"

Boundary:
  Direct --database-url introspection is intentionally disabled in this public alpha.
  Keep credentials local, export SQL schema, then introspect the file.
`);
}
