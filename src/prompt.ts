import { CliError } from "./errors.js";

/** Reads a line from the terminal without echoing it. */
export async function readHidden(question: string): Promise<string> {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) {
    throw new CliError(
      "There's no terminal to ask on. Pipe the key in instead: inboundr login --with-token < key.txt",
      2,
    );
  }
  stderr.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          finish();
          resolve(value.trim());
          return;
        }
        if (ch === "\u0003" || ch === "\u0004") {
          finish();
          reject(new CliError("Cancelled.", 130));
          return;
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** All of stdin, for `--with-token` and `--text -`. */
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
