// SPDX-FileCopyrightText: 2021 Anders Rune Jensen
//
// SPDX-License-Identifier: LGPL-3.0-only

const Obv = require('obz')
const bipf = require('bipf')
const fic = require('fastintcompression')
const bsb = require('binary-search-bounds')
const clarify = require('clarify-error')
const { readFile, writeFile } = require('atomic-file-rw')
const toBuffer = require('typedarray-to-buffer')
const ssbKeys = require('ssb-keys')
const DeferredPromise = require('p-defer')
const path = require('path')
const Debug = require('debug')
const SSBURI = require('ssb-uri2')

const { indexesPath } = require('../defaults')

module.exports = function (dir, sbot, config) {
  const latestOffset = Obv()
  const stateLoaded = DeferredPromise()
  let encrypted = []
  let canDecrypt = []

  const startDecryptBox1 = config.db2.startDecryptBox1
    ? new Date(config.db2.startDecryptBox1)
    : null

  const debug = Debug('ssb:db2:private')

  const encryptedFile = path.join(indexesPath(dir), 'encrypted.index')
  // an option is to cache the read keys instead of only where the
  // messages are, this has an overhead around storage.  The
  // performance of that is a decrease in unbox time to 50% of
  // original for box1 and around 75% box2
  const canDecryptFile = path.join(indexesPath(dir), 'canDecrypt.index')

  function save(filename, arr) {
    const buf = toBuffer(fic.compress(arr))
    const b = Buffer.alloc(4 + buf.length)
    b.writeInt32LE(latestOffset.value, 0)
    buf.copy(b, 4)

    writeFile(filename, b, (err) => {
      // prettier-ignore
      if (err) console.error(clarify(err, 'private plugin failed to save file ' + filename))
    })
  }

  function load(filename, cb) {
    readFile(filename, (err, buf) => {
      if (err) return cb(err)
      else if (!buf) return cb(new Error('empty file'))

      const offset = buf.readInt32LE(0)
      const body = buf.slice(4)

      cb(null, { offset, arr: fic.uncompress(body) })
    })
  }

  function loadIndexes(cb) {
    load(encryptedFile, (err, data) => {
      if (err) {
        debug('failed to load encrypted')
        latestOffset.set(-1)
        if (sbot.box2) sbot.box2.isReady(stateLoaded.resolve)
        else stateLoaded.resolve()
        if (err.code === 'ENOENT') cb()
        else if (err.message === 'empty file') cb()
        // prettier-ignore
        else cb(clarify(err, 'private plugin failed to load "encrypted" index'))
        return
      }

      const { offset, arr } = data
      encrypted = arr

      debug('encrypted loaded', encrypted.length)

      load(canDecryptFile, (err, data) => {
        let canDecryptOffset = -1
        if (!err) {
          canDecrypt = data.arr
          canDecryptOffset = data.offset
          debug('canDecrypt loaded', canDecrypt.length)
        }

        latestOffset.set(Math.min(offset, canDecryptOffset))
        if (sbot.box2) sbot.box2.isReady(stateLoaded.resolve)
        else stateLoaded.resolve()
        debug('loaded offset', latestOffset.value)

        cb()
      })
    })
  }

  loadIndexes((err) => {
    if (err) throw err
  })

  let savedTimer
  function saveIndexes(cb) {
    if (!savedTimer) {
      savedTimer = setTimeout(() => {
        savedTimer = null
        save(encryptedFile, encrypted)
        save(canDecryptFile, canDecrypt)
      }, 1000)
    }
    cb()
  }

  function reconstructMessage(record, unboxedContent) {
    const msg = bipf.decode(record.value, 0)
    const originalContent = msg.value.content
    if (
      SSBURI.isBendyButtV1FeedSSBURI(msg.value.author) &&
      Array.isArray(unboxedContent)
    ) {
      msg.value.content = unboxedContent[0]
      msg.value.contentSignature = unboxedContent[1]
    } else msg.value.content = unboxedContent

    msg.meta = {
      private: true,
      originalContent,
    }

    const len = bipf.encodingLength(msg)
    const buf = Buffer.alloc(len)
    bipf.encode(msg, buf, 0)

    return { offset: record.offset, value: buf }
  }

  const BIPF_VALUE = bipf.allocAndEncode('value')
  const BIPF_CONTENT = bipf.allocAndEncode('content')
  const BIPF_AUTHOR = bipf.allocAndEncode('author')
  const BIPF_PREVIOUS = bipf.allocAndEncode('previous')
  const BIPF_TIMESTAMP = bipf.allocAndEncode('timestamp')

  function decryptBox1(ciphertext, keys) {
    return ssbKeys.unbox(ciphertext, keys)
  }

  function tryDecryptContent(ciphertext, recBuffer, pValue) {
    let content = ''
    if (ciphertext.endsWith('.box')) {
      content = decryptBox1(ciphertext, config.keys)
    } else if (sbot.box2 && ciphertext.endsWith('.box2')) {
      const pAuthor = bipf.seekKey2(recBuffer, pValue, BIPF_AUTHOR, 0)
      if (pAuthor >= 0) {
        const author = bipf.decode(recBuffer, pAuthor)
        const pPrevious = bipf.seekKey2(recBuffer, pValue, BIPF_PREVIOUS, 0)
        if (pPrevious >= 0) {
          const previousMsg = bipf.decode(recBuffer, pPrevious)
          content = sbot.box2.decryptBox2(ciphertext, author, previousMsg)
        }
      }
    }
    return content
  }

  function decrypt(record, streaming) {
    const recOffset = record.offset
    const recBuffer = record.value
    if (!recBuffer) return record
    let p = 0 // note you pass in p!
    if (bsb.eq(canDecrypt, recOffset) !== -1) {
      const pValue = bipf.seekKey2(recBuffer, p, BIPF_VALUE, 0)
      if (pValue < 0) return record
      const pContent = bipf.seekKey2(recBuffer, pValue, BIPF_CONTENT, 0)
      if (pContent < 0) return record

      const ciphertext = bipf.decode(recBuffer, pContent)
      const content = tryDecryptContent(ciphertext, recBuffer, pValue)
      if (!content) return record

      const originalMsg = reconstructMessage(record, content)
      return originalMsg
    } else if (recOffset > latestOffset.value || !streaming) {
      if (streaming) latestOffset.set(recOffset)

      const pValue = bipf.seekKey2(recBuffer, p, BIPF_VALUE, 0)
      if (pValue < 0) return record
      const pContent = bipf.seekKey2(recBuffer, pValue, BIPF_CONTENT, 0)
      if (pContent < 0) return record

      const type = bipf.getEncodedType(recBuffer, pContent)
      if (type !== bipf.types.string) return record

      const ciphertext = bipf.decode(recBuffer, pContent)

      if (ciphertext.endsWith('.box') && startDecryptBox1) {
        const pTimestamp = bipf.seekKey2(recBuffer, pValue, BIPF_TIMESTAMP, 0)
        const declaredTimestamp = bipf.decode(recBuffer, pTimestamp)
        if (declaredTimestamp < startDecryptBox1) return record
      }
      if (streaming && ciphertext.endsWith('.box2')) encrypted.push(recOffset)

      const content = tryDecryptContent(ciphertext, recBuffer, pValue)
      if (!content) return record

      if (!streaming) {
        // since we use bsb for canDecrypt we need to ensure recOffset
        // is inserted at the correct place when reindexing
        const insertLocation = bsb.gt(canDecrypt, recOffset)
        canDecrypt.splice(insertLocation, 0, recOffset)
      } else canDecrypt.push(recOffset)

      if (!streaming) saveIndexes(() => {})
      return reconstructMessage(record, content)
    } else {
      return record
    }
  }

  function missingDecrypt() {
    let canDecryptSet = new Set(canDecrypt)

    return encrypted.filter((x) => !canDecryptSet.has(x))
  }

  function reset(cb) {
    encrypted = []
    canDecrypt = []
    latestOffset.set(-1)
    saveIndexes(cb)
  }

  return {
    latestOffset,
    decrypt,
    missingDecrypt,
    saveIndexes,
    reset,
    stateLoaded: stateLoaded.promise,
  }
}

module.exports.reEncrypt = function (msg) {
  if (msg.meta && msg.meta.private) {
    msg.value.content = msg.meta.originalContent
    delete msg.meta
  }
  return msg
}
