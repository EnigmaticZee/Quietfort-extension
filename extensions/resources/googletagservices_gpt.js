// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
(function(){var n=function(){};var self=function(){return this};
var slot={addService:self,clearCategoryExclusions:self,clearTargeting:self,defineSizeMapping:self,
get:function(){return null},getAdUnitPath:function(){return''},getAttributeKeys:function(){return[]},
getCategoryExclusions:function(){return[]},getDomId:function(){return''},getSlotElementId:function(){return''},
getTargeting:function(){return[]},getTargetingKeys:function(){return[]},set:self,setCategoryExclusion:self,
setClickUrl:self,setCollapseEmptyDiv:self,setTargeting:self,setConfig:self};
var pubads={addEventListener:self,removeEventListener:self,clear:n,clearCategoryExclusions:self,clearTagForChildDirectedTreatment:self,
clearTargeting:self,collapseEmptyDivs:self,defineOutOfPagePassback:function(){return slot},definePassback:function(){return slot},
disableInitialLoad:n,display:n,enableAsyncRendering:n,enableLazyLoad:n,enableSingleRequest:n,enableSyncRendering:n,enableVideoAds:n,
get:function(){return null},getAttributeKeys:function(){return[]},getTargeting:function(){return[]},getTargetingKeys:function(){return[]},
getSlots:function(){return[]},isInitialLoadDisabled:function(){return true},refresh:n,set:self,setCategoryExclusion:self,
setCentering:n,setCookieOptions:self,setForceSafeFrame:self,setLocation:self,setPrivacySettings:self,setPublisherProvidedId:self,
setRequestNonPersonalizedAds:self,setSafeFrameConfig:self,setTagForChildDirectedTreatment:self,setTargeting:self,
setVideoContent:self,updateCorrelator:n};
var gt=window.googletag||{};var cmd=gt.cmd||[];
gt.apiReady=true;gt.pubadsReady=true;gt.pubads=function(){return pubads};gt.companionAds=function(){return pubads};
gt.content=function(){return pubads};gt.defineSlot=function(){return slot};gt.defineOutOfPageSlot=function(){return slot};
gt.destroySlots=n;gt.disablePublisherConsole=n;gt.display=n;gt.enableServices=n;gt.getVersion=function(){return''};
gt.openConsole=n;gt.setAdIframeTitle=n;gt.setConfig=n;gt.sizeMapping=function(){var b={addSize:function(){return b},build:function(){return[]}};return b};
gt.cmd={push:function(f){try{f()}catch(e){}return 1}};window.googletag=gt;
if(Array.isArray(cmd)){cmd.forEach(function(f){try{f()}catch(e){}})}})();
