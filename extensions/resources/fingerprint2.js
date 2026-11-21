// Written from scratch for AdBlocker: a Fingerprint2 stand-in returning a random, per-page id.
(function () {
  var id = '';
  for (var i = 0; i < 32; i++) id += Math.floor(Math.random() * 16).toString(16);
  function Fingerprint2() { if (!(this instanceof Fingerprint2)) return new Fingerprint2(); }
  Fingerprint2.prototype.get = function (cb) { setTimeout(function () { if (typeof cb === 'function') cb(id, []); }, 1); };
  Fingerprint2.get = function (opts, cb) { if (typeof opts === 'function') cb = opts; setTimeout(function () { if (typeof cb === 'function') cb([]); }, 1); };
  Fingerprint2.getV18 = function (opts, cb) { if (typeof opts === 'function') cb = opts; setTimeout(function () { if (typeof cb === 'function') cb(id, []); }, 1); };
  Fingerprint2.getPromise = function () { return Promise.resolve([]); };
  Fingerprint2.x64hash128 = function () { return id; };
  Fingerprint2.VERSION = '2.1.0';
  window.Fingerprint2 = Fingerprint2;
})();
