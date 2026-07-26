/**
 * ExecCommandRunner — the real `CommandRunner`, a thin `execFile` wrapper.
 *
 * Kept tiny and injectable so the OS backends never call `child_process`
 * directly: tests pass a fake runner and assert the exact command + args without
 * spawning anything.
 */

import { execFile } from "node:child_process";
import type { CommandRunner } from "./types.js";

export class ExecCommandRunner implements CommandRunner {
  run(command: string, args: string[], input?: Buffer): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const child = execFile(
        command,
        args,
        { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(stdout as Buffer);
        },
      );
      if (input !== undefined) {
        child.stdin?.on("error", () => {
          /* ignore EPIPE when the tool exits before reading all input */
        });
        child.stdin?.end(input);
      }
    });
  }

  exists(command: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      // `command -v` via the shell resolves builtins, aliases and PATH entries.
      execFile("sh", ["-c", `command -v ${command}`], (error) => resolve(!error));
    });
  }
}
