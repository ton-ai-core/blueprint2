#!/usr/bin/env node
/**
 * check-wrappers-tact.js – TEMPORARY Tact-only wrapper validator
 *
 * Behaviour
 * ----------
 * • Runs only when build/ (any depth) contains at least one *.ts artefact.
 * • Enforces original rules A–E:
 *     A  skip helpers/tests/d.ts
 *     B  exit 0 if ./build/ absent
 *     C  no extends/implements Contract directly
 *     D  alias import + subclass required when referencing ../build/
 *     E  mandatory static methods (init? , fromInit, fromAddress) with no `any`
 * • Extra F-rules:
 *     fromInit  → async, Promise<Class>, calls AliasWrapper.init + contractAddress + new Class
 *     fromAddress → returns new Class(address)
 * • When fromInit / fromAddress is missing, prints a ready-made snippet.
 * • Exits with code 1 and summary if errors; otherwise prints a single ✅ line.
 */

const fs   = require("fs");
const path = require("path");
const { Project } = require("ts-morph");

const ROOT      = process.cwd();
const BUILD_DIR = path.join(ROOT, "build");
const WRAP_DIR  = path.join(ROOT, "wrappers");
const BUILD_REL = "build";

/* ───── early exit if no build artefacts ───── */
function hasBuildTs(dir) {
  if (!fs.existsSync(dir)) return false;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.name.endsWith(".ts")) return true;
    }
  }
  return false;
}
if (!hasBuildTs(BUILD_DIR)) process.exit(0);

/* ───── folder guard ───── */
if (!fs.existsSync(WRAP_DIR)) {
  console.error("❌  wrappers/ folder not found.");
  process.exit(1);
}

/* ───── ts-morph project ───── */
const project = new Project({
  tsConfigFilePath: path.join(ROOT, "tsconfig.json"),
  skipAddingFilesFromTsConfig: true,
});

/* ───── helpers ───── */
let errors = 0;
const isWrapper = f =>
  /^[\w-]+\.ts$/.test(f) &&
  !/\.compile\.ts$|\.test\.ts$|\.spec\.ts$/i.test(f) &&
  !f.endsWith(".d.ts");

const walk = d => {
  const out = [];
  const stack = [d];
  while (stack.length) {
    const cur = stack.pop();
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (isWrapper(ent.name)) out.push(full);
    }
  }
  return out;
};

const err = (file, lines) => {
  console.error(`\n[❌] ${path.relative(ROOT, file)}:`);
  lines.forEach(l => console.error("   " + l));
  errors += 1;
};

const snippet = (Cls, Alias) => [
  "```ts",
  "import { Address, Cell, contractAddress } from '@ton/core';",
  `import { ${Cls} as ${Alias} } from '../build/${Cls}/${Cls}_${Cls}';`,
  "",
  `export class ${Cls} extends ${Alias} {`,
  "    constructor(address: Address, init?: { code: Cell; data: Cell }) {",
  "        super(address, init);",
  "    }",
  "",
  `    static async fromInit(...): Promise<${Cls}> {`,
  `        const __gen_init = await ${Alias}.init(...);`,
  "        const address = contractAddress(0, __gen_init);",
  `        return new ${Cls}(address, __gen_init);`,
  "    }",
  "",
  `    static fromAddress(address: Address): ${Cls} {`,
  `        return new ${Cls}(address);`,
  "    }",
  "",
  "    // ToDo: your logic here",
  "}",
  "```",
];

/* ───── validation ───── */
walk(WRAP_DIR).forEach(file => {
  const sf  = project.addSourceFileAtPath(file);

  /* C-01 – forbid direct Contract */
  sf.getClasses().forEach(cls => {
    const ext = cls.getExtends()?.getText();
    const imp = cls.getImplements().some(i => i.getText() === "Contract");
    if (ext === "Contract" || imp) {
      err(file, [
        `• Class ${cls.getName()} extends/implements 'Contract' directly.`,
        "  Must extend the generated <Name>Wrapper instead.",
      ]);
    }
  });

  /* alias import detection */
  const impDecl = sf.getImportDeclarations()
    .find(d => d.getModuleSpecifierValue().includes(`../${BUILD_REL}/`));
  const hasExport = sf.getExportDeclarations().some(d =>
    d.getModuleSpecifierValue()?.includes(`../${BUILD_REL}/`)
  );
  if (!impDecl && !hasExport) return; // no build reference → ignore

  if (hasExport && !impDecl)
    return err(file, ["• Re-export without an alias import."]);

  const aliasSpec = impDecl?.getNamedImports().find(n => n.getAliasNode());
  if (!aliasSpec)
    return err(file, ["• Alias import must look like { Foo as FooWrapper }"]);

  const aliasWrapper = aliasSpec.getAliasNode().getText(); // FooWrapper
  const parentName   = aliasSpec.getNameNode().getText();  // Foo
  const genPath      = path.resolve(path.dirname(file),
                                    impDecl.getModuleSpecifierValue() + ".ts");
  if (!fs.existsSync(genPath)) return; // generated file absent → skip deep checks

  const cls = sf.getClass(() => true);
  if (!cls)
    return err(file, [`• Wrapper class missing. Expected export class ${parentName} extends ${aliasWrapper}.`]);
  if (cls.getExtends()?.getText() !== aliasWrapper)
    err(file, [`• ${cls.getName()} must extend ${aliasWrapper}.`]);

  /* mandatory static methods list */
  const required     = [
    ["fromInit",    `static async fromInit(...): Promise<${parentName}>`],
    ["fromAddress", `static fromAddress(address: Address): ${parentName}`],
  ];

  required.forEach(([name, sig]) => {
    const m = cls.getStaticMethod(name);
    if (!m) {
      const extra = (name === "fromInit" || name === "fromAddress")
        ? ["", "  Example implementation:", ...snippet(parentName, aliasWrapper)]
        : [];
      return err(file, [`• Missing mandatory method → ${sig}`, ...extra]);
    }
    const badAny =
      (m.getReturnTypeNode()?.getText() || "").includes("any") ||
      m.getParameters().some(p => (p.getTypeNode()?.getText() || "").includes("any"));
    if (badAny) err(file, [`• Method ${name} uses forbidden type 'any'.`]);
  });

  /* F-rules */
  const fi = cls.getStaticMethod("fromInit");
  if (fi) {
    const fiErr = [];
    if (!fi.isAsync()) fiErr.push("• fromInit must be declared `async`.");
    const ret = fi.getReturnTypeNode()?.getText() || "";
    if (!ret.match(new RegExp(`^Promise<\\s*${parentName}\\s*>$`)))
      fiErr.push(`• fromInit must return Promise<${parentName}>.`);
    const body = fi.getBodyText() || "";
    if (!body.includes("contractAddress("))
      fiErr.push("• fromInit must call contractAddress(…).");
    if (!body.includes(`new ${parentName}(`))
      fiErr.push(`• fromInit must instantiate new ${parentName}(…).`);
    if (fiErr.length) err(file, fiErr);
  }

  const fa = cls.getStaticMethod("fromAddress");
  if (fa) {
    const body = fa.getBodyText() || "";
    if (!body.includes(`new ${parentName}(address`))
      err(file, ["• fromAddress must return new " + parentName + "(address)."]);
  }
});

/* ───── summary / exit ───── */
if (errors) {
  console.error(`\nΣ errors: ${errors} — build aborted.`);
  process.exit(1);
}
console.log("✅ Wrapper validation passed.");
