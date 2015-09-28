// When processed by webpack, this file bundles up all the JS for the
// standalone client.
//
// When loaded by the development server, index.html supplies a require
// function to load these.

// Right now, these are manually ordered so that all dependencies are
// satisfied.  Before long, we'd like to convert these into real modules
// and/or better shims, and push the dependencies down into the modules
// themselves so that this manual management step goes away.

// To get started, we're using webpack's script loader to load these things in
// as-is.

/* global require */

require("script!shared/libs/sdk.js");

require("script!./libs/l10n-gaia-02ca67948fe8.js");
require("script!shared/libs/react-0.12.2.js");
require("script!shared/libs/lodash-3.9.3.js");
require("script!shared/libs/backbone-1.2.1.js");

require("script!shared/js/utils.js");
require("script!shared/js/crypto.js");
require("script!shared/js/mixins.js");
require("script!shared/js/actions.js");
require("script!shared/js/validate.js");
require("script!shared/js/dispatcher.js");
require("script!shared/js/websocket.js");
require("script!shared/js/otSdkDriver.js");
require("script!shared/js/store.js");
require("script!shared/js/activeRoomStore.js");
require("script!shared/js/views.js");
require("script!shared/js/urlRegExps.js");
require("script!shared/js/textChatStore.js");
require("script!shared/js/textChatView.js");
require("script!shared/js/linkifiedTextView.js");

require("script!./js/standaloneAppStore.js");
require("script!./js/standaloneMozLoop.js");
require("script!./js/standaloneRoomViews.js");
require("script!./js/standaloneMetricsStore.js");
require("script!./js/webapp.js");
