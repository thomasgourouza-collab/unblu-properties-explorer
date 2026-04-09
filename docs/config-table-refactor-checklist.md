# Config Table Refactor Checklist

Use this checklist during incremental refactor steps to verify behavior has not changed.

## Baseline checks

- [ ] `npm run build` passes before refactor.
- [ ] App loads rows automatically.
- [ ] `Re-login` still triggers refresh flow.

## Config import checks

- [ ] `Import config -> From file` accepts JSON.
- [ ] `Import config -> From file` accepts YAML.
- [ ] `Import config -> From file` accepts `.properties`.
- [ ] Unknown keys open the missing-keys dialog.
- [ ] `$_version` is ignored.

## Account integration checks

- [ ] `Import config -> From account` connects and imports account data.
- [ ] Connect dialog closes only from explicit controls.
- [ ] `Export config -> To file` still exports `.json/.yaml/.properties`.
- [ ] `Export config -> To account` still patches based on `Source`.
- [ ] Success toast appears after successful export to account.

## Table interaction checks

- [ ] Selection counts and labels are correct.
- [ ] Global + column filters still work together.
- [ ] Filter chips remove via the close icon only.
- [ ] Menu outside-click and Escape close behavior remains unchanged.
- [ ] Table settings persist and restore.

## Final checks per increment

- [ ] `npm run build` passes.
- [ ] `npm run build:backend` passes (when backend/shared contracts changed).
- [ ] No new blocking lint errors in touched files.
