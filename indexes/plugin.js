const Obv = require('obv')
const Level = require('level')
const path = require('path')
const Debug = require('debug')

module.exports = function (log, dir, name, version,
                           handleData, writeData, beforeIndexUpdate) {
  const indexesPath = path.join(dir, 'db2', 'indexes', name)
  const debug = Debug('ssb:db2:' + name)

  if (typeof window === 'undefined') { // outside browser
    const mkdirp = require('mkdirp')
    mkdirp.sync(indexesPath)
  }

  const level = Level(indexesPath)
  const META = '\x00'
  const chunkSize = 512
  let isLive = false
  let processed = 0
  const seq = Obv()
  seq.set(-1)

  function updateIndexes() {
    const start = Date.now()

    let unWrittenSeq = 0

    function writeBatch(cb) {
      level.put(META, { version, seq: seq.value, processed },
                { valueEncoding: 'json' },
                (err) => { if (err) throw err })

      writeData(cb)
    }

    function onData(data) {
      unWrittenSeq = handleData(data, processed)
      processed++

      if (unWrittenSeq > chunkSize || isLive) {
        writeBatch((err) => {
          if (err) throw err
          seq.set(data.seq)
        })
      }
    }

    log.stream({ gt: seq.value }).pipe({
      paused: false,
      write: onData,
      end: () => {
        if (unWrittenSeq > 0) {
          writeBatch((err) => {
            if (err) throw err
            seq.set(unWrittenSeq)
          })
        }

        debug(`index scan time: ${Date.now()-start}ms, items: ${processed}`)

        isLive = true
        log.stream({ gt: seq.value, live: true }).pipe({
          paused: false,
          write: onData
        })
      }
    })
  }

  level.get(META, { valueEncoding: 'json' }, (err, data) => {
    debug(`got index status:`, data)

    if (data && data.version == version) {
      seq.set(data.seq)
      processed = data.processed
      if (beforeIndexUpdate)
        beforeIndexUpdate(updateIndexes)
      else
        updateIndexes()
    } else
      level.clear(updateIndexes)
  })

  return { level, seq }
}