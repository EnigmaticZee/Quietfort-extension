// Written from scratch for AdBlocker: a stand-in for Google's IMA SDK (ima3.js)
// that reports "no ads" so video players start the content right away.
(function () {
  'use strict';
  var w = window;
  if (w.google && w.google.ima && w.google.ima.__adblockerStub) return;
  var noop = function () {};
  function Emitter() { this._l = {}; }
  Emitter.prototype.addEventListener = function (t, fn) { if (typeof fn === 'function') (this._l[t] = this._l[t] || []).push(fn); };
  Emitter.prototype.removeEventListener = function (t, fn) { var a = this._l[t]; if (a) { var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } };
  Emitter.prototype._emit = function (t, ev) { (this._l[t] || []).slice().forEach(function (fn) { try { fn(ev); } catch (e) {} }); };
  var extend = function (C) { C.prototype = Object.create(Emitter.prototype); C.prototype.constructor = C; return C; };

  function AdError(message) { this.message = message; this.errorCode = 1009; }
  AdError.prototype.getErrorCode = function () { return this.errorCode; };
  AdError.prototype.getMessage = function () { return this.message; };
  AdError.prototype.getType = function () { return 'adLoadError'; };
  AdError.prototype.getVastErrorCode = function () { return 303; };
  AdError.prototype.getInnerError = function () { return null; };
  AdError.prototype.toString = function () { return 'AdError ' + this.errorCode + ': ' + this.message; };
  AdError.ErrorCode = { VAST_EMPTY_RESPONSE: 1009, UNKNOWN_ERROR: 900, FAILED_TO_REQUEST_ADS: 1005 };
  AdError.Type = { AD_LOAD: 'adLoadError', AD_PLAY: 'adPlayError' };

  function AdErrorEvent(error, ctx) { this.type = 'adError'; this._error = error; this._ctx = ctx; }
  AdErrorEvent.prototype.getError = function () { return this._error; };
  AdErrorEvent.prototype.getUserRequestContext = function () { return this._ctx || {}; };
  AdErrorEvent.Type = { AD_ERROR: 'adError' };

  function AdEvent(type) { this.type = type; }
  AdEvent.prototype.getAd = function () { return null; };
  AdEvent.prototype.getAdData = function () { return {}; };
  AdEvent.Type = {
    AD_BREAK_READY: 'adBreakReady', AD_BUFFERING: 'adBuffering', AD_METADATA: 'adMetadata', AD_PROGRESS: 'adProgress',
    ALL_ADS_COMPLETED: 'allAdsCompleted', CLICK: 'click', COMPLETE: 'complete', CONTENT_PAUSE_REQUESTED: 'contentPauseRequested',
    CONTENT_RESUME_REQUESTED: 'contentResumeRequested', DURATION_CHANGE: 'durationChange', FIRST_QUARTILE: 'firstQuartile',
    IMPRESSION: 'impression', INTERACTION: 'interaction', LINEAR_CHANGED: 'linearChanged', LOADED: 'loaded', LOG: 'log',
    MIDPOINT: 'midpoint', PAUSED: 'pause', RESUMED: 'resume', SKIPPABLE_STATE_CHANGED: 'skippableStateChanged', SKIPPED: 'skip',
    STARTED: 'start', THIRD_QUARTILE: 'thirdQuartile', USER_CLOSE: 'userClose', VIDEO_CLICKED: 'videoClicked',
    VIDEO_ICON_CLICKED: 'videoIconClicked', VOLUME_CHANGED: 'volumeChange', VOLUME_MUTED: 'mute'
  };

  var AdsManager = extend(function AdsManager() { Emitter.call(this); this._volume = 1; });
  ['collapse', 'configureAdsManager', 'destroy', 'discardAdBreak', 'expand', 'focus', 'init', 'pause', 'requestNextAdBreak',
    'resize', 'resume', 'setAdWillPlayMuted', 'setAutoPlayAdBreaks', 'skip', 'stop', 'updateAdsRenderingSettings', 'clicked']
    .forEach(function (m) { AdsManager.prototype[m] = noop; });
  AdsManager.prototype.start = function () {
    var self = this;
    setTimeout(function () {
      self._emit('contentResumeRequested', new AdEvent('contentResumeRequested'));
      self._emit('allAdsCompleted', new AdEvent('allAdsCompleted'));
    }, 0);
  };
  AdsManager.prototype.getAdSkippableState = function () { return false; };
  AdsManager.prototype.getCuePoints = function () { return []; };
  AdsManager.prototype.getCurrentAd = function () { return null; };
  AdsManager.prototype.getRemainingTime = function () { return 0; };
  AdsManager.prototype.getVolume = function () { return this._volume; };
  AdsManager.prototype.setVolume = function (v) { this._volume = v; };
  AdsManager.prototype.isCustomClickTrackingUsed = function () { return false; };
  AdsManager.prototype.isCustomPlaybackUsed = function () { return false; };

  function AdsManagerLoadedEvent(ctx) { this.type = 'adsManagerLoaded'; this._ctx = ctx; }
  AdsManagerLoadedEvent.prototype.getAdsManager = function () { return new AdsManager(); };
  AdsManagerLoadedEvent.prototype.getUserRequestContext = function () { return this._ctx || {}; };
  AdsManagerLoadedEvent.Type = { ADS_MANAGER_LOADED: 'adsManagerLoaded' };

  function ImaSdkSettings() { this._locale = 'en'; this._redirects = 4; }
  ['setAutoPlayAdBreaks', 'setCompanionBackfill', 'setCookiesEnabled', 'setDisableCustomPlaybackForIOS10Plus', 'setFeatureFlags',
    'setNumRedirects', 'setPlayerType', 'setPlayerVersion', 'setPpid', 'setSessionId', 'setVpaidAllowed', 'setVpaidMode']
    .forEach(function (m) { ImaSdkSettings.prototype[m] = noop; });
  ImaSdkSettings.prototype.setLocale = function (l) { this._locale = l; };
  ImaSdkSettings.prototype.getLocale = function () { return this._locale; };
  ImaSdkSettings.prototype.getNumRedirects = function () { return this._redirects; };
  ImaSdkSettings.prototype.getPlayerType = function () { return ''; };
  ImaSdkSettings.prototype.getPlayerVersion = function () { return ''; };
  ImaSdkSettings.prototype.getPpid = function () { return ''; };
  ImaSdkSettings.prototype.getFeatureFlags = function () { return {}; };
  ImaSdkSettings.prototype.getDisableCustomPlaybackForIOS10Plus = function () { return false; };
  ImaSdkSettings.prototype.isCookiesEnabled = function () { return false; };
  ImaSdkSettings.prototype.isVpaidAdapter = function () { return false; };
  ImaSdkSettings.VpaidMode = { DISABLED: 0, ENABLED: 1, INSECURE: 2 };
  var settings = new ImaSdkSettings();

  var AdsLoader = extend(function AdsLoader() { Emitter.call(this); });
  AdsLoader.prototype.contentComplete = noop;
  AdsLoader.prototype.destroy = noop;
  AdsLoader.prototype.getSettings = function () { return settings; };
  AdsLoader.prototype.getVersion = function () { return '3.0.0'; };
  AdsLoader.prototype.requestAds = function (req, ctx) {
    var self = this;
    setTimeout(function () { self._emit('adError', new AdErrorEvent(new AdError('No ads available'), ctx)); }, 0);
  };

  function AdDisplayContainer() {}
  AdDisplayContainer.prototype.initialize = noop;
  AdDisplayContainer.prototype.destroy = noop;
  function AdsRequest() {}
  ['setAdWillAutoPlay', 'setAdWillPlayMuted', 'setContinuousPlayback'].forEach(function (m) { AdsRequest.prototype[m] = noop; });
  function AdsRenderingSettings() {}
  function CompanionAdSelectionSettings() {}
  CompanionAdSelectionSettings.CreativeType = { ALL: 'All', FLASH: 'Flash', IMAGE: 'Image' };
  CompanionAdSelectionSettings.ResourceType = { ALL: 'All', HTML: 'Html', IFRAME: 'IFrame', STATIC: 'Static' };
  CompanionAdSelectionSettings.SizeCriteria = { IGNORE: 'IgnoreSize', SELECT_EXACT_MATCH: 'SelectExactMatch', SELECT_NEAR_MATCH: 'SelectNearMatch' };

  var ima = {
    __adblockerStub: true,
    AdCuePoints: function () {}, AdDisplayContainer: AdDisplayContainer, AdError: AdError, AdErrorEvent: AdErrorEvent,
    AdEvent: AdEvent, AdsLoader: AdsLoader, AdsManager: AdsManager, AdsManagerLoadedEvent: AdsManagerLoadedEvent,
    AdsRenderingSettings: AdsRenderingSettings, AdsRequest: AdsRequest, CompanionAdSelectionSettings: CompanionAdSelectionSettings,
    ImaSdkSettings: ImaSdkSettings, OmidAccessMode: { DOMAIN: 'domain', FULL: 'full', LIMITED: 'limited' },
    OmidVerificationVendor: {}, UiElements: { AD_ATTRIBUTION: 'adAttribution', COUNTDOWN: 'countdown' },
    UniversalAdIdInfo: function () {}, ViewMode: { FULLSCREEN: 'fullscreen', NORMAL: 'normal' },
    settings: settings, VERSION: '3.0.0'
  };
  w.google = w.google || {};
  w.google.ima = ima;
})();
