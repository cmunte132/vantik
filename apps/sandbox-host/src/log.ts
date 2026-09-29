/**
 * One JSON line per event, in the same shape as the server's log.
 *
 * Never give a sandbox spec, a request body or a secret to this logger. The
 * sandbox host holds the model key of every running sandbox, and a log line is
 * the easiest place for one to leak.
 */
type Fields = Record<string, unknown>;

function write(lvl: string, msg: string, fields: Fields = {}) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    lvl,
    ctx: "SandboxHost",
    msg,
    ...fields,
  });

  (lvl === "ERROR" ? process.stderr : process.stdout).write(`${line}\n`);
}

export const log = {
  info: (msg: string, fields?: Fields) => write("INFO", msg, fields),
  warn: (msg: string, fields?: Fields) => write("WARN", msg, fields),
  error: (msg: string, fields?: Fields) => write("ERROR", msg, fields),
};
