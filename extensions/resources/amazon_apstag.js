// Written from scratch for AdBlocker: Amazon publisher tag stand-in that returns no bids.
(function () {
  var noop = function () {};
  window.apstag = {
    _Q: [], debug: noop, deleteId: noop, dpa: noop, init: noop, punt: noop, renderImp: noop, rpa: noop, upa: noop, setDisplayBids: noop,
    fetchBids: function (cfg, cb) { if (typeof cb === 'function') setTimeout(function () { cb([]); }, 1); },
    targetingKeys: function () { return []; }
  };
})();
