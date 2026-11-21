// Written from scratch for AdBlocker: FuckAdBlock / BlockAdBlock stand-in that never detects a blocker.
(function () {
  var self = function () { return this; };
  function Fake() {}
  Fake.prototype = {
    check: function () { return false; }, clearEvent: self, emitEvent: self, setOption: self, setOptions: self, onDetected: self,
    onNotDetected: function (fn) { if (typeof fn === 'function') setTimeout(fn, 1); return this; },
    on: function (detected, fn) { if (!detected && typeof fn === 'function') setTimeout(fn, 1); return this; }
  };
  var inst = new Fake();
  window.FuckAdBlock = window.BlockAdBlock = window.SniffAdBlock = Fake;
  window.fuckAdBlock = window.blockAdBlock = window.sniffAdBlock = inst;
})();
