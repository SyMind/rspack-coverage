#!/usr/bin/env node

import { startStoredCoverage } from "./server/startStoredCoverage.js";

interface CliOptions {
  dataDir?: string;
  port?: number;
  open: boolean;
  historyApiFallback: boolean;
  help: boolean;
}

const HELP = `rspack-coverage serve [options]

Open the Rspack Coverage workbench without running a build. The latest saved
snapshot is restored automatically; when none exists, upload one in the page.

Options:
  --data-dir <path>              Snapshot directory (default: node_modules/.cache/rspack-coverage)
  --port <number>                Preferred local port (default: 4868)
  --no-open                      Do not open the report in a browser
  --no-history-api-fallback      Disable application HTML fallback
  -h, --help                     Show this help
`;

function optionValue(arguments_: string[], index: number, name: string): [string, number] {
  const current = arguments_[index] ?? "";
  const inline = current.startsWith(`${name}=`) ? current.slice(name.length + 1) : null;
  if (inline !== null) {
    if (!inline) throw new Error(`${name} requires a value.`);
    return [inline, index];
  }
  const value = arguments_[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`${name} requires a value.`);
  return [value, index + 1];
}

function parseArguments(arguments_: string[]): CliOptions {
  const options: CliOptions = {
    open: true,
    historyApiFallback: true,
    help: false,
  };
  let index = arguments_[0] === "serve" ? 1 : 0;
  for (; index < arguments_.length; index += 1) {
    const argument = arguments_[index] ?? "";
    if (argument === "-h" || argument === "--help") {
      options.help = true;
    } else if (argument === "--no-open") {
      options.open = false;
    } else if (argument === "--no-history-api-fallback") {
      options.historyApiFallback = false;
    } else if (argument === "--data-dir" || argument.startsWith("--data-dir=")) {
      const [value, nextIndex] = optionValue(arguments_, index, "--data-dir");
      options.dataDir = value;
      index = nextIndex;
    } else if (argument === "--port" || argument.startsWith("--port=")) {
      const [value, nextIndex] = optionValue(arguments_, index, "--port");
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("--port must be an integer between 1 and 65535.");
      }
      options.port = port;
      index = nextIndex;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const running = await startStoredCoverage(options);
  const build = running.snapshot?.manifest;
  const status = build
    ? `restored build ${build.hash.slice(0, 12)} without running Rspack`
    : "started without a saved build; upload a .rspack-coverage file in the report";
  console.log(
    `\nRspack Coverage ${status}.\n\nReusable data:\n${running.dataDirectory}\n\n${build ? `Application:\n${running.origin}/\n\n` : ""}Coverage report:\n${running.origin}/__rspack_coverage__/\n\nPress Ctrl+C to stop.\n`,
  );

  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void running.server
      .close()
      .then(() => {
        process.exitCode = 0;
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

void main().catch((error) => {
  console.error(
    `Rspack Coverage could not start: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
