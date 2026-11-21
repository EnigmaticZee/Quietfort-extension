// Written from scratch for AdBlocker: a FingerprintJS v3 stand-in returning a random, per-page id.
(function () {
  var id = '';
  for (var i = 0; i < 32; i++) id += Math.floor(Math.random() * 16).toString(16);
  var agent = { get: function () { return Promise.resolve({ visitorId: id, components: {}, confidence: { score: 0.5 }, version: '3.4.0' }); } };
  window.FingerprintJS = { load: function () { return Promise.resolve(agent); }, hashComponents: function () { return id; }, componentsToDebugString: function () { return ''; } };
})();
