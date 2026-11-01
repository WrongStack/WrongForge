/**
 * Unit tests for the tool implementations: edit (str_replace semantics),
 * glob (pattern matching), grep (content search), todo list round-trip.
 *
 *   npx tsx test/tools.test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  agentTools,
  compileGlob,
  expandBraces,
  globToRegExp,
  htmlToText,
  isPrivateAddress,
  truncateMiddle,
} from "../src/tools/index.js";

const run = (t: any, input: any) => t.execute(input);

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`assertion failed: ${label}`);
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-tools-test-"));
  process.chdir(dir);

  // --- globToRegExp ---
  assert(globToRegExp("**/*.ts").test("a.ts"), "glob **/*.ts matches top-level file");
  assert(globToRegExp("**/*.ts").test("src/deep/x.ts"), "glob **/*.ts matches nested file");
  assert(!globToRegExp("**/*.ts").test("src/x.js"), "glob **/*.ts rejects other extension");
  assert(globToRegExp("src/*.ts").test("src/x.ts"), "glob src/*.ts matches");
  assert(!globToRegExp("src/*.ts").test("src/a/b.ts"), "glob src/*.ts does not cross directories");
  assert(globToRegExp("f?le.txt").test("file.txt"), "glob ? wildcard");
  assert(globToRegExp("a.b.txt").test("a.b.txt") && !globToRegExp("a.b.txt").test("axb.txt"), "glob dots escaped");

  // --- write + read (numbered lines) ---
  const w = await run(agentTools.write, {
    path: "src/app.ts",
    content: "line one\nline two\nline three\n",
  });
  assert(w.ok === true, "write ok");
  const r = await run(agentTools.read, { path: "src/app.ts" });
  assert(r.ok === true && r.totalLines === 3, "read counts 3 lines (trailing newline is not a line)");
  assert(r.content.startsWith("     1\tline one"), "read returns cat -n style numbering");
  const r2 = await run(agentTools.read, { path: "src/app.ts", offset: 2, limit: 1 });
  assert(r2.content.trim() === "2\tline two", "read offset/limit works");

  // --- edit: exact replace ---
  const e1 = await run(agentTools.edit, {
    path: "src/app.ts",
    old_string: "line two",
    new_string: "LINE TWO",
  });
  assert(e1.ok === true && e1.replacements === 1, "edit replaces unique string");

  // --- edit: not found ---
  const e2 = await run(agentTools.edit, {
    path: "src/app.ts",
    old_string: "does not exist",
    new_string: "x",
  });
  assert(e2.ok === false && /not found/.test(e2.error), "edit errors when old_string missing");

  // --- edit: ambiguous ---
  await run(agentTools.write, { path: "dup.txt", content: "same\nsame\n" });
  const e3 = await run(agentTools.edit, {
    path: "dup.txt",
    old_string: "same",
    new_string: "other",
  });
  assert(e3.ok === false && /2 times/.test(e3.error), "edit errors on ambiguous old_string");
  const e4 = await run(agentTools.edit, {
    path: "dup.txt",
    old_string: "same",
    new_string: "other",
    replace_all: true,
  });
  assert(e4.ok === true && e4.replacements === 2, "edit replace_all works");
  const dupContent = fs.readFileSync(path.join(dir, "dup.txt"), "utf8");
  assert(dupContent === "other\nother\n", "replace_all updated the file");

  // --- glob tool ---
  const g = await run(agentTools.glob, { pattern: "**/*.ts" });
  assert(g.ok === true && g.files.includes("src/app.ts"), "glob tool finds src/app.ts");
  assert(!g.files.some((f: string) => f.includes("dup.txt")), "glob filters by pattern");

  // --- grep tool ---
  const gr = await run(agentTools.grep, { pattern: "LINE TWO" });
  assert(gr.ok === true && gr.matches.some((m: string) => m.startsWith("src/app.ts:")), "grep finds the edited line");
  const grGlob = await run(agentTools.grep, { pattern: "same", ignore_case: true });
  assert(grGlob.ok === true, "grep with ignore_case ok");
  const grNone = await run(agentTools.grep, { pattern: "no-such-token-xyz" });
  assert(grNone.ok === true && grNone.matches.length === 0, "grep returns no matches");

  // --- grep ignores node_modules ---
  fs.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "pkg", "i.ts"), "no-such-token-xyz\n");
  const grSkip = await run(agentTools.grep, { pattern: "no-such-token-xyz" });
  assert(grSkip.matches.length === 0, "grep skips node_modules");

  // --- write reports bytes, not characters ---
  const wb = await run(agentTools.write, { path: "utf8.txt", content: "çş" });
  assert(wb.ok === true && wb.bytes === 4, "write reports UTF-8 byte count");

  // --- hidden directories are searched (only IGNORED_DIRS are skipped) ---
  fs.mkdirSync(path.join(dir, ".github"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".github", "ci.yml"), "hidden-dir-token\n");
  const gh = await run(agentTools.grep, { pattern: "hidden-dir-token" });
  assert(gh.matches.some((m: string) => m.startsWith(".github/")), "grep descends into .github");
  const gg = await run(agentTools.glob, { pattern: ".github/*.yml" });
  assert(gg.files.includes(".github/ci.yml"), "glob finds files in hidden dirs");

  // --- web_fetch refuses non-public targets ---
  for (const url of [
    "http://127.0.0.1:1/",
    "http://localhost:1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/",
    "http://[::1]/",
    "http://[::ffff:7f00:1]/", // IPv4-mapped loopback in its canonical hex form
    "file:///etc/passwd",
  ]) {
    const f = await run(agentTools.web_fetch, { url });
    assert(f.ok === false && /blocked|unsupported/.test(f.error), `web_fetch blocks ${url}`);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:808:808"]) {
    assert(!isPrivateAddress(ip), `${ip} is public`);
  }
  for (const ip of ["172.16.0.1", "172.31.255.1", "192.168.1.1", "100.64.0.1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:7f00:1", "::ffff:c0a8:1"]) {
    assert(isPrivateAddress(ip), `${ip} is private`);
  }

  // --- todo round-trip ---
  const tw = await run(agentTools.todo_write, {
    todos: [
      { content: "first task", status: "completed" },
      { content: "second task", status: "in_progress", activeForm: "Working on the second task" },
    ],
  });
  assert(tw.ok === true && tw.count === 2, "todo_write replaces the list");
  const tr: any = await run(agentTools.todo_read, {});
  assert(tr.todos.length === 2 && tr.todos[1].status === "in_progress", "todo_read returns the list");
  const twBad = await run(agentTools.todo_write, {
    todos: [
      { content: "a", status: "in_progress" },
      { content: "b", status: "in_progress" },
    ],
  });
  assert(twBad.ok === false, "todo_write rejects two in_progress items");

  await extendedTests(dir);

  process.chdir("/");
  // Windows: an external process holding a handle inside the tree (observed:
  // a local indexer daemon) makes rmSync throw EPERM long after every test
  // child exited. The suite's job is tool correctness, not temp hygiene —
  // retry briefly and warn-and-continue instead of failing on OS temp state.
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) {
    console.warn(`[tools.test] could not remove ${dir} (${(e as NodeJS.ErrnoException).code}) — an external process holds it; leaving it for OS temp cleanup`);
  }
  console.log("TOOLS TESTS PASSED ✓ (bash, read/write/edit, ls, glob, grep, web_fetch, todos)");
}

async function extendedTests(root: string): Promise<void> {
  const w = path.join(root, "ext");
  fs.mkdirSync(w, { recursive: true });
  process.chdir(w);

  // --- glob syntax: braces, classes, basename matching ---
  assert(
    JSON.stringify(expandBraces("a.{ts,tsx}")) === JSON.stringify(["a.ts", "a.tsx"]),
    "expandBraces simple",
  );
  assert(expandBraces("{a,b{c,d}}").length === 3, "expandBraces nested");
  assert(expandBraces("x{y}z")[0] === "x{y}z", "brace group without comma stays literal");
  assert(globToRegExp("src/**/*.{ts,tsx}").test("src/a/b.tsx"), "glob braces match");
  assert(!globToRegExp("src/**/*.{ts,tsx}").test("src/a/b.js"), "glob braces reject");
  assert(globToRegExp("file[0-9].txt").test("file7.txt"), "glob [range]");
  assert(globToRegExp("file[!0-9].txt").test("filex.txt"), "glob [!range] matches other");
  assert(!globToRegExp("file[!0-9].txt").test("file7.txt"), "glob [!range] rejects");
  assert(globToRegExp("a\\b.txt").test("a/b.txt"), "glob backslash treated as separator");
  const m1 = compileGlob("*.json");
  assert(m1("package.json") && m1("deep/dir/x.json"), "slash-less glob matches at any depth");
  const m2 = compileGlob("src/*.ts");
  assert(m2("src/a.ts") && !m2("other/src/a.ts") && !m2("src/x/a.ts"), "glob with slash matches path");

  // --- truncateMiddle keeps both ends ---
  const tm = truncateMiddle("A".repeat(50) + "B".repeat(50), 20);
  assert(tm.startsWith("AAAAAAAA") && tm.endsWith("BBBBBBBBBBBB") && /omitted/.test(tm), "truncateMiddle head+tail");
  assert(truncateMiddle("short", 20) === "short", "truncateMiddle leaves short text");

  // --- bash ---
  const b1 = await run(agentTools.bash, { command: "node -e \"console.log('hi')\"" });
  assert(b1.ok === true && b1.exitCode === 0 && b1.stdout.trim() === "hi", "bash runs a command");
  assert(typeof b1.durationMs === "number", "bash reports duration");
  const b2 = await run(agentTools.bash, {
    command: "node -e \"console.error('oops');process.exit(3)\"",
  });
  assert(b2.ok === false && b2.exitCode === 3 && /oops/.test(b2.stderr), "bash exit code + stderr");
  const b3 = await run(agentTools.bash, {
    command: "node -e \"setInterval(()=>{},1000)\"",
    timeout_ms: 500,
  });
  assert(b3.timedOut === true && b3.ok === false && /timeout/.test(b3.note), "bash reports timeout");
  assert(b3.durationMs < 8000, "bash timeout returns promptly");
  const b4 = await run(agentTools.bash, {
    command: "node -e \"console.log('a'.repeat(100000)+'THE-END')\"",
  });
  assert(/THE-END/.test(b4.stdout) && /omitted/.test(b4.stdout), "bash keeps the tail of long output");
  assert(b4.stdout.length < 21_000, "bash output is bounded");
  const b5 = await run(agentTools.bash, { command: "echo x", cwd: "no-such-dir-xyz" });
  assert(b5.ok === false && /cwd/.test(b5.error), "bash rejects a missing cwd");
  fs.mkdirSync("sub");
  const b6 = await run(agentTools.bash, {
    command: "node -e \"console.log(process.cwd())\"",
    cwd: "sub",
  });
  assert(b6.stdout.trim().endsWith("sub"), "bash honours cwd");
  const b7 = await run(agentTools.bash, {
    command: "node -e \"process.stdin.on('end',()=>console.log('eof')).resume()\"",
    timeout_ms: 5000,
  });
  assert(b7.stdout.trim() === "eof", "bash closes stdin (interactive prompts cannot hang)");
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const b8 = await (agentTools.bash as any).execute(
    { command: "node -e \"setInterval(()=>{},1000)\"", timeout_ms: 60_000 },
    { abortSignal: ac.signal },
  );
  assert(b8.ok === false && b8.timedOut === undefined && b8.durationMs < 8000, "bash stops promptly on abort (Ctrl+C)");

  // --- read edge cases ---
  fs.writeFileSync("crlf.txt", "one\r\ntwo\r\nthree\r\n");
  const rc = await run(agentTools.read, { path: "crlf.txt" });
  assert(rc.totalLines === 3 && !rc.content.includes("\r"), "read strips CR from CRLF files");
  fs.writeFileSync("empty.txt", "");
  const re0 = await run(agentTools.read, { path: "empty.txt" });
  assert(re0.ok === true && re0.totalLines === 0 && re0.note === "file is empty", "read empty file");
  const rd = await run(agentTools.read, { path: "sub" });
  assert(rd.ok === false && /directory/.test(rd.error) && /ls/.test(rd.error), "read rejects a directory");
  fs.writeFileSync("bin.dat", Buffer.from([1, 2, 0, 3, 4]));
  const rb = await run(agentTools.read, { path: "bin.dat" });
  assert(rb.ok === false && /binary/.test(rb.error), "read rejects binary files");
  const rm = await run(agentTools.read, { path: "nope.txt" });
  assert(rm.ok === false && /no such file/.test(rm.error), "read reports a missing file clearly");
  const ro = await run(agentTools.read, { path: "crlf.txt", offset: 99 });
  assert(ro.ok === false && /beyond/.test(ro.error), "read rejects an offset past the end");
  fs.writeFileSync("long.txt", "x".repeat(5000) + "\nshort\n");
  const rl = await run(agentTools.read, { path: "long.txt" });
  assert(/line truncated, 5000 chars/.test(rl.content), "read cuts very long lines");
  fs.writeFileSync(
    "big.txt",
    Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n"),
  );
  const rbig = await run(agentTools.read, { path: "big.txt" });
  assert(rbig.truncated === true && rbig.shownTo === 2000 && rbig.nextOffset === 2001, "read paginates with nextOffset");
  const rbig2 = await run(agentTools.read, { path: "big.txt", offset: rbig.nextOffset });
  assert(rbig2.shownTo === 3000 && rbig2.truncated === false, "read continues from nextOffset");
  fs.writeFileSync("wide.txt", Array.from({ length: 1000 }, () => "y".repeat(200)).join("\n"));
  const rw = await run(agentTools.read, { path: "wide.txt" });
  assert(rw.truncated === true && rw.shownTo < 1000, "read stops at the char budget");
  assert(rw.content.split("\n").length === rw.shownTo, "read shownTo matches the rows actually returned");

  // --- write ---
  const wc = await run(agentTools.write, { path: "w1.txt", content: "a" });
  const wo = await run(agentTools.write, { path: "w1.txt", content: "b" });
  assert(wc.created === true && wo.created === false, "write reports created vs overwritten");
  const wd = await run(agentTools.write, { path: "sub", content: "x" });
  assert(wd.ok === false && /directory/.test(wd.error), "write refuses to overwrite a directory");

  // --- edit ---
  fs.writeFileSync("price.txt", "cost: PLACEHOLDER\n");
  const ed1 = await run(agentTools.edit, {
    path: "price.txt",
    old_string: "PLACEHOLDER",
    new_string: "$& and $1 and $$ and $'",
  });
  assert(ed1.ok === true, "edit with $ in new_string succeeds");
  assert(
    fs.readFileSync("price.txt", "utf8") === "cost: $& and $1 and $$ and $'\n",
    "edit treats new_string literally ($ patterns not expanded)",
  );
  fs.writeFileSync("price2.txt", "a\na\n");
  await run(agentTools.edit, { path: "price2.txt", old_string: "a", new_string: "$&$&", replace_all: true });
  assert(fs.readFileSync("price2.txt", "utf8") === "$&$&\n$&$&\n", "replace_all treats new_string literally");

  fs.writeFileSync("win.txt", "first\r\nsecond\r\nthird\r\n");
  const ed2 = await run(agentTools.edit, {
    path: "win.txt",
    old_string: "first\nsecond",
    new_string: "ONE\nTWO",
  });
  assert(ed2.ok === true, "edit matches LF old_string against a CRLF file");
  assert(fs.readFileSync("win.txt", "utf8") === "ONE\r\nTWO\r\nthird\r\n", "edit keeps CRLF line endings");

  assert((await run(agentTools.edit, { path: "win.txt", old_string: "", new_string: "x" })).ok === false, "edit rejects empty old_string");
  const ed3 = await run(agentTools.edit, { path: "win.txt", old_string: "third", new_string: "third" });
  assert(ed3.ok === false && /identical/.test(ed3.error), "edit rejects identical strings");
  const ed4 = await run(agentTools.edit, { path: "nope.txt", old_string: "a", new_string: "b" });
  assert(ed4.ok === false && /no such file/.test(ed4.error), "edit reports a missing file");

  fs.writeFileSync("hint.ts", "function foo() {\n    return 1;\n}\n");
  const ed5 = await run(agentTools.edit, {
    path: "hint.ts",
    old_string: "  return 1;",
    new_string: "  return 2;",
  });
  assert(ed5.ok === true, "substring of an indented line still matches exactly");
  const ed6 = await run(agentTools.edit, {
    path: "hint.ts",
    old_string: "function foo()  {",
    new_string: "x",
  });
  assert(ed6.ok === false, "edit fails on whitespace mismatch");
  const ed7 = await run(agentTools.edit, {
    path: "hint.ts",
    old_string: "function foo()  {\n    return 2;",
    new_string: "x",
  });
  assert(ed7.ok === false && /line\(s\) 2/.test(ed7.error) === false, "no bogus hint line");
  const ed8 = await run(agentTools.edit, {
    path: "hint.ts",
    old_string: "return 2;  \n}",
    new_string: "x",
  });
  assert(ed8.ok === false && /line\(s\) 2/.test(ed8.error), "edit not-found hint points at the matching first line");

  fs.writeFileSync("amb.txt", "x\ny\nx\nz\nx\n");
  const ed9 = await run(agentTools.edit, { path: "amb.txt", old_string: "x", new_string: "q" });
  assert(ed9.ok === false && /3 times \(lines 1, 3, 5\)/.test(ed9.error), "edit lists line numbers of ambiguous matches");
  const ed10 = await run(agentTools.edit, { path: "amb.txt", old_string: "z", new_string: "Z" });
  assert(ed10.ok === true && ed10.line === 4, "edit reports the line it changed");

  // --- ls ---
  fs.mkdirSync("lsdir/zdir", { recursive: true });
  fs.writeFileSync("lsdir/a.txt", "12345");
  fs.writeFileSync("lsdir/b.txt", "");
  const l1 = await run(agentTools.ls, { path: "lsdir" });
  assert(l1.ok === true && l1.total === 3 && l1.truncated === false, "ls counts entries");
  assert(l1.entries[0].name === "zdir" && l1.entries[0].type === "dir", "ls lists directories first");
  assert(l1.entries[1].name === "a.txt" && l1.entries[1].bytes === 5, "ls reports file sizes");
  const l2 = await run(agentTools.ls, { path: "lsdir/a.txt" });
  assert(l2.ok === false && /file, not a directory/.test(l2.error), "ls on a file explains itself");
  const l3 = await run(agentTools.ls, { path: "missing-dir" });
  assert(l3.ok === false && /no such file/.test(l3.error), "ls on a missing path errors");
  fs.mkdirSync("many");
  for (let i = 0; i < 520; i++) fs.writeFileSync(path.join("many", `f${i}.txt`), "");
  const l4 = await run(agentTools.ls, { path: "many" });
  assert(l4.entries.length === 500 && l4.total === 520 && l4.truncated === true, "ls flags truncation");

  // --- glob ---
  fs.mkdirSync("gl/a", { recursive: true });
  fs.writeFileSync("gl/a/x.ts", "");
  fs.writeFileSync("gl/a/y.tsx", "");
  fs.writeFileSync("gl/a/z.js", "");
  fs.writeFileSync("gl/top.json", "");
  const g1 = await run(agentTools.glob, { pattern: "**/*.{ts,tsx}", path: "gl" });
  assert(g1.ok === true && g1.count === 2 && g1.files.includes("a/x.ts") && g1.files.includes("a/y.tsx"), "glob brace expansion");
  const g2 = await run(agentTools.glob, { pattern: "*.json", path: "gl" });
  assert(g2.files.length === 1 && g2.files[0] === "top.json", "glob slash-less pattern");
  const g3 = await run(agentTools.glob, { pattern: "**/*", path: "gl", max: 2 });
  assert(g3.count === 4 && g3.files.length === 2 && g3.truncated === true, "glob reports truncation and total");
  const g4 = await run(agentTools.glob, { pattern: "*", path: "no-such" });
  assert(g4.ok === false && /not found/.test(g4.error), "glob on a missing root errors");

  // --- grep ---
  const gm = await run(agentTools.grep, { pattern: "x", path: "no-such" });
  assert(gm.ok === false && /not found/.test(gm.error), "grep on a missing path errors (not empty success)");
  const gbad = await run(agentTools.grep, { pattern: "(" });
  assert(gbad.ok === false && /invalid regex/.test(gbad.error), "grep reports an invalid regex");
  fs.mkdirSync("gr");
  fs.writeFileSync("gr/one.txt", "alpha\nbeta\ngamma\ndelta\nepsilon\nbeta again\n");
  fs.writeFileSync("gr/two.txt", "nothing here\nbeta\n");
  fs.writeFileSync("gr/skip.md", "beta\n");
  const gf = await run(agentTools.grep, { pattern: "beta", path: "gr", output_mode: "files_with_matches" });
  assert(
    gf.ok === true && gf.matches.length === 3 && gf.matches.includes("one.txt") && gf.matches.includes("skip.md"),
    "grep files_with_matches lists each file once",
  );
  const gc = await run(agentTools.grep, { pattern: "beta", path: "gr", output_mode: "count", glob: "*.txt" });
  assert(
    gc.matches.includes("one.txt:2") && gc.matches.includes("two.txt:1") && gc.matches.length === 2,
    "grep count mode + glob filter",
  );
  const gx = await run(agentTools.grep, { pattern: "gamma", path: "gr/one.txt", context: 1 });
  assert(
    JSON.stringify(gx.matches) === JSON.stringify(["one.txt-2- beta", "one.txt:3: gamma", "one.txt-4- delta"]),
    "grep context lines use '-' and the match uses ':'",
  );
  const gx2 = await run(agentTools.grep, { pattern: "alpha|epsilon", path: "gr/one.txt", context: 1 });
  assert(gx2.matches.includes("--") && gx2.matchCount === 2, "grep separates non-adjacent context groups");
  const gx3 = await run(agentTools.grep, { pattern: "beta|gamma", path: "gr/one.txt", context: 1 });
  assert(!gx3.matches.includes("--"), "grep merges overlapping context windows");
  const gl1 = await run(agentTools.grep, { pattern: "beta", path: "gr", max_results: 4 });
  assert(gl1.truncated === false && gl1.matchCount === 4, "grep not truncated when results == limit");
  const gl2 = await run(agentTools.grep, { pattern: "beta", path: "gr", max_results: 3 });
  assert(gl2.truncated === true && gl2.matchCount === 3, "grep truncated when more matches exist");
  fs.writeFileSync("gr/min.js", "a".repeat(1000) + "NEEDLE" + "b".repeat(1000) + "\n");
  const gmin = await run(agentTools.grep, { pattern: "NEEDLE", path: "gr/min.js" });
  assert(gmin.matches[0].includes("NEEDLE") && gmin.matches[0].length < 400, "grep windows long lines around the match");
  fs.writeFileSync("gr/crlf.txt", "keep\r\nthis\r\n");
  const gcr = await run(agentTools.grep, { pattern: "keep$", path: "gr/crlf.txt" });
  assert(gcr.matchCount === 1, "grep anchors work on CRLF files");

  // --- htmlToText ---
  const h = htmlToText(
    "<html><head><title>My &amp; Page</title><style>p{}</style></head><body>" +
      "<script>evil()</script><h1>Head</h1><p>Para &amp;lt; one</p><ul><li>a</li><li>b</li></ul>" +
      "<p>x&nbsp;y &#65;&#x42; &unknown; <b>bold</b>text</p></body></html>",
  );
  assert(h.title === "My & Page", "htmlToText extracts + decodes the title");
  assert(!/evil|p\{\}/.test(h.text), "htmlToText drops script/style");
  assert(h.text.includes("Para &lt; one"), "htmlToText does not double-decode &amp;lt;");
  assert(/\n- a\n- b/.test(h.text), "htmlToText keeps list structure");
  assert(h.text.includes("x y AB &unknown; boldtext"), "htmlToText numeric/named entities + inline tags");
  assert(h.text.split("\n").length >= 4, "htmlToText keeps block structure on separate lines");

  // --- web_fetch ---
  const wf = await run(agentTools.web_fetch, { url: "http://user:pw@example.com/" });
  assert(wf.ok === false && /credentials/.test(wf.error), "web_fetch rejects embedded credentials");

  // --- todo extras ---
  const t1: any = await run(agentTools.todo_write, {
    todos: [
      { content: "a", status: "completed" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "pending" },
    ],
  });
  assert(t1.completed === 1 && t1.inProgress === 1 && t1.pending === 1, "todo_write reports a status summary");
  const t2: any = await run(agentTools.todo_write, { todos: [] });
  assert(t2.ok === true && t2.count === 0, "todo_write can clear the list");
  assert(((await run(agentTools.todo_read, {})) as any).todos.length === 0, "todo list is empty after clearing");

  process.chdir(root);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
