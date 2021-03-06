<!--
SPDX-FileCopyrightText: 2022 Andre 'Staltz' Medeiros

SPDX-License-Identifier: CC0-1.0
-->

## 4.0.0

### Breaking changes

- JITDB indexes are now stored in `db2/jit` while previously they were stored in `db2/indexes`. Updating ssb-db2 from 3.0.0 to 4.0.0 requires no changes in your code, but if you want to avoid the JITDB indexes being rebuilt from scratch, then you'll have to move all `*.32prefix`, `*.32prefixmap`, and `*.index` files (**except** `canDecrypt.index` and `encrypted.index`) from `db2/indexes/` to `db2/jit/`.

## 3.0.0

### Breaking changes

- Previously, ssb-db2 emitted events on the secret-stack event emitter with event names `ssb:db2:indexing:progress` and `ssb:db2:migrate:progress`. From version 3.0.0 those have been replaced by conventional muxrpc `source` APIs at `sbot.db2.indexingProgress()` and `sbot.db2migrate.progress()`, respectively.

## 2.0.0

### Breaking changes

- ssb-db2 now uses `jitdb@3` with the new `where()` operator. All your queries will have to be updated to use `where()`, even though it's straightforward to adopt this new operator.
