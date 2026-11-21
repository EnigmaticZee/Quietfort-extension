// Written from scratch for AdBlocker: inert PopAds globals.
(function () { var o = {}; try { Object.defineProperty(window, 'PopAds', { get: function () { return o; }, set: function () {} }); Object.defineProperty(window, 'popns', { get: function () { return 'PopAds'; }, set: function () {} }); } catch (e) {} })();
