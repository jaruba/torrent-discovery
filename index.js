module.exports = Discovery

var debug = require('debug')('torrent-discovery')
var DHT = require('bittorrent-dht/client') // empty object in browser
var EventEmitter = require('events').EventEmitter
var extend = require('xtend')
var inherits = require('inherits')
var parallel = require('run-parallel')
var Tracker = require('bittorrent-tracker/client')

inherits(Discovery, EventEmitter)

function Discovery (opts) {

  var self = this
  if (!(self instanceof Discovery)) return new Discovery(opts)
  EventEmitter.call(self)

  if (!opts.peerId) throw new Error('Option `peerId` is required')
  if (!opts.infoHash) throw new Error('Option `infoHash` is required')
  if (!process.browser && !opts.port) throw new Error('Option `port` is required')

  self.noSeeding = opts && opts.noSeeding

  self.niceSeeder = false;
  self.whenSeeder = 0;
  self.seedDelay = 0;

  self.peerId = typeof opts.peerId === 'string'
    ? opts.peerId
    : opts.peerId.toString('hex')
  self.infoHash = typeof opts.infoHash === 'string'
    ? opts.infoHash.toLowerCase()
    : opts.infoHash.toString('hex')
  self._port = opts.port // torrent port
  self._userAgent = opts.userAgent // User-Agent header for http requests

  self.destroyed = false

  self._announce = opts.announce || []
  self._intervalMs = opts.intervalMs || (15 * 60 * 1000)
  self._trackerOpts = null
  self._dhtAnnouncing = false
  self._dhtTimeout = false
  self._internalDHT = false // is the DHT created internally?

  self._onWarning = function (err) {
    self.emit('warning', err)
  }
  self._onError = function (err) {
    self.emit('error', err)
  }
  self._onDHTPeer = function (peer, infoHash) {
    if (infoHash.toString('hex') !== self.infoHash) return
    self.emit('peer', { address: peer.host + ':' + peer.port, force: (self.amSeeder && !self.noSeeding) }, 'dht')
  }
  self._onTrackerPeer = function (peer) {
    self.emit('peer', { address: peer, force: (self.amSeeder && !self.noSeeding) }, 'tracker')
  }
  self._onTrackerAnnounce = function () {
    self.emit('trackerAnnounce')
  }

  if (opts.tracker === false) {
    self.tracker = null
  } else if (opts.tracker && typeof opts.tracker === 'object') {
    self._trackerOpts = extend(opts.tracker)
    self.tracker = self._createTracker()
  } else {
    self.tracker = self._createTracker()
  }

  if (opts.dht === false || typeof DHT !== 'function') {
    self.dht = null
  } else if (opts.dht && typeof opts.dht.addNode === 'function') {
    self.dht = opts.dht
  } else if (opts.dht && typeof opts.dht === 'object') {
    self.dht = createDHT(opts.dhtPort, opts.dht)
  } else {
    self.dht = createDHT(opts.dhtPort)
  }

  if (self.dht) {
    self.dht.on('peer', self._onDHTPeer)
    self._dhtAnnounce()
  }

  function createDHT (port, opts) {
    var dht = new DHT(opts)
    dht.on('warning', self._onWarning)
    dht.on('error', self._onError)
    dht.listen(port)
    self._internalDHT = true
    return dht
  }
}

Discovery.prototype.updatePort = function (port) {
  var self = this
  if (port === self._port) return
  self._port = port

  if (self.dht) self._dhtAnnounce()

  if (self.tracker) {
    self.tracker.stop()
    self.tracker.destroy(function () {
      self.tracker = self._createTracker()
    })
  }
}

Discovery.prototype.setTorrent = function () {
  
}

Discovery.prototype.seedCheck = function (oldOpts) {
  this.complete(oldOpts);
  var changed = false
  if (this.seedDelay == 180000 && this.whenSeeder < Date.now() - 600000) {
    // 10 min passed => 5 min interval
    this.seedDelay = 300000;
    changed = true;
  } else if (this.seedDelay == 300000 && this.whenSeeder < Date.now() - 1800000) {
    // 30 min passed => 10 min interval
    this.seedDelay = 600000;
    changed = true;
  } else if (this.seedDelay == 600000 && this.whenSeeder < Date.now() - 3600000) {
    // 60 min passed => 15 min interval
    this.seedDelay = 900000;
    changed = true;
  } else if (this.seedDelay == 600000 && this.whenSeeder < Date.now() - 7200000) {
    // 120 min passed => 30 min interval
    this.seedDelay = 1800000;
    changed = true;
  }
  if (changed) {
    clearInterval(this.niceSeeder);
    this.niceSeeder = setInterval(this.seedCheck, this.seedDelay);
  }
};

Discovery.prototype.complete = function (opts) {
  this.amSeeder = true;

  if (!this.noSeeding) {
    if (this.tracker) {
      if (!this.niceSeeder) {
        this.whenSeeder = Date.now();
        this.seedDelay = 180000; // start at a 3 min interval
        this.niceSeeder = setInterval(this.seedCheck.bind(this, opts), this.seedDelay);
      }
      this.tracker.complete(opts)
    }
  }
}

Discovery.prototype.update = function (opts) {
  if (!this.amSeeder) {
    if (this.tracker)
      this.tracker.update(opts);
  }
}

Discovery.prototype.destroy = function (cb) {
  var self = this
  if (self.destroyed) return
  self.destroyed = true

  if (self.niceSeeder) {
    clearInterval(self.niceSeeder);
    self.niceSeeder = false;
  }

  clearTimeout(self._dhtTimeout)

  var tasks = []

  if (self.tracker) {
    self.tracker.stop()
    self.tracker.removeListener('warning', self._onWarning)
    self.tracker.removeListener('error', self._onError)
    self.tracker.removeListener('peer', self._onTrackerPeer)
    self.tracker.removeListener('update', self._onTrackerAnnounce)
    tasks.push(function (cb) {
      self.tracker.destroy(cb)
    })
  }

  if (self.dht) {
    self.dht.removeListener('peer', self._onDHTPeer)
  }

  if (self._internalDHT) {
    self.dht.removeListener('warning', self._onWarning)
    self.dht.removeListener('error', self._onError)
    tasks.push(function (cb) {
      self.dht.destroy(cb)
    })
  }

  parallel(tasks, cb)

  // cleanup
  self.dht = null
  self.tracker = null
  self._announce = null
}

Discovery.prototype._createTracker = function () {
  var opts = extend(this._trackerOpts, {
    infoHash: this.infoHash,
    announce: this._announce,
    peerId: this.peerId,
    port: this._port,
    userAgent: this._userAgent
  })

  var tracker = new Tracker(opts)
  tracker.on('warning', this._onWarning)
  tracker.on('error', this._onError)
  tracker.on('peer', this._onTrackerPeer)
  tracker.on('update', this._onTrackerAnnounce)
  tracker.setInterval(this._intervalMs)
  tracker.start()
  return tracker
}

Discovery.prototype._dhtAnnounce = function () {
  var self = this
  if (self._dhtAnnouncing) return
  debug('dht announce')

  self._dhtAnnouncing = true
  clearTimeout(self._dhtTimeout)

  self.dht.announce(self.infoHash, self._port, function (err) {
    self._dhtAnnouncing = false
    debug('dht announce complete')

    if (err) self.emit('warning', err)
    self.emit('dhtAnnounce')

    if (!self.destroyed) {
      self._dhtTimeout = setTimeout(function () {
        self._dhtAnnounce()
      }, getRandomTimeout())
      if (self._dhtTimeout.unref) self._dhtTimeout.unref()
    }
  })

  // Returns timeout interval, with some random jitter
  function getRandomTimeout () {
    return self._intervalMs + Math.floor(Math.random() * self._intervalMs / 5)
  }
}
