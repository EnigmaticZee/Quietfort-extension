// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
(function(){var n=function(){};var t={get:n,set:n,send:n};
var ga=function(){var a=arguments;if(!a.length)return;var l=a[a.length-1];
if(l&&typeof l==='object'&&typeof l.hitCallback==='function'){try{l.hitCallback()}catch(e){}}
else if(typeof l==='function'){try{l(t)}catch(e){}}};
ga.create=function(){return t};ga.getByName=function(){return null};ga.getAll=function(){return[]};
ga.remove=n;ga.loaded=true;var k=window.GoogleAnalyticsObject||'ga';var q=window[k]&&window[k].q;
window[k]=ga;if(Array.isArray(q)){q.forEach(function(x){try{ga.apply(null,x)}catch(e){}})}})();
