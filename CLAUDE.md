# desplega.ai-action

## Versioning

Versions are tracked via **git tags** (not `package.json`). The tag format is `vX.Y.Z`.

To bump the version after a commit:
```
git tag v<new-version>
```

Always create a new tag when shipping changes. Use semver: patch for fixes, minor for new features.

## Build

After modifying source files, rebuild the dist bundle:
```
npm run package
```

The `dist/index.js` must be committed — it's the action entry point.
