module.exports = {
  branches: ["main"],
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    ["@semantic-release/changelog", { changelogFile: "changelog.md" }],
    ["@semantic-release/npm", { npmPublish: false }],
    [
      "@semantic-release/exec",
      { publishCmd: "npm publish --provenance --access public" },
    ],
    "@semantic-release/github",
    [
      "@semantic-release/git",
      {
        assets: ["package.json", "bun.lock", "changelog.md"],
        message: "chore(release): ${nextRelease.version} [skip ci]",
      },
    ],
  ],
};
