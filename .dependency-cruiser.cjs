/** Architecture rules (SPEC §2.1): enforced, not aspirational. */
module.exports = {
  forbidden: [
    {
      name: "no-cycles",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "core-stays-pure",
      comment: "core never imports from api/functions/web",
      severity: "error",
      from: { path: "^packages/core" },
      to: { path: "^packages/(api|functions|web)" },
    },
    {
      name: "aws-sdk-only-in-adapters",
      comment: "@aws-sdk/* is reachable only from core/adapters/",
      severity: "error",
      from: {
        path: "^packages/core",
        // Tests construct real clients for DynamoDB Local; that is wiring,
        // not domain logic leaking into infra.
        pathNot: "^packages/core/(src/adapters|test)",
      },
      to: { path: "node_modules/@aws-sdk/" },
    },
    {
      name: "contract-is-a-leaf",
      comment: "contract depends on nothing in the workspace",
      severity: "error",
      from: { path: "^packages/contract" },
      to: { path: "^packages/(core|api|functions|web|scripts)" },
    },
    {
      name: "api-not-into-functions",
      severity: "error",
      from: { path: "^packages/api" },
      to: { path: "^packages/(functions|web)" },
    },
  ],
  options: {
    // node_modules is doNotFollow (edges recorded, not traversed) rather than
    // excluded — excluding it erases the very edges the @aws-sdk rule matches.
    // The exclude stays anchored to our packages: an unanchored "dist" would
    // match "dist-cjs" inside resolved node_modules paths and erase them too.
    doNotFollow: { path: "node_modules" },
    exclude: { path: "^packages/[^/]+/(dist|src/generated)/" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
  },
};
