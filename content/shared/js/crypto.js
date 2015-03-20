/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global loop:true */

var loop = loop || {};

loop.crypto = (function() {
  "use strict";

  var ALGORITHM = "AES-GCM";
  var KEY_LENGTH = 128;
  // We use JSON web key formats for the generated keys.
  // https://tools.ietf.org/html/draft-ietf-jose-json-web-key-41
  var KEY_FORMAT = "jwk";
  // This is the JSON web key type from the generateKey algorithm.
  var KEY_TYPE = "oct";
  var ENCRYPT_TAG_LENGTH = 128;
  var INITIALIZATION_VECTOR_LENGTH = 12;

  var sharedUtils = loop.shared.utils;

  /**
   * Root object, by default set to window.
   * @type {DOMWindow|Object}
   */
  var rootObject = window;

  /**
   * Sets a new root object.  This is useful for testing crypto not supported as
   * it allows us to fake crypto not being present.
   * In beforeEach(), loop.crypto.setRootObject is used to
   * substitute a fake window, and in afterEach(), the real window object is
   * replaced.
   *
   * @param {Object}
   */
  function setRootObject(obj) {
    console.log("loop.crpyto.mixins: rootObject set to " + obj);
    rootObject = obj;
  }

  /**
   * Determines if Web Crypto is supported by this browser.
   *
   * @return {Boolean} True if Web Crypto is supported
   */
  function isSupported() {
    return "crypto" in rootObject;
  }

  /**
   * Generates a random key using the Web Crypto libraries.
   *
   * @return {Promise} A promise which is rejected on failure, or resolved
   *                   with a string that is in the JSON web key format.
   */
  function generateKey() {
    if (!isSupported()) {
      throw new Error("Web Crypto is not supported");
    }

    return new Promise(function(resolve, reject) {
      // First get a crypto key.
      rootObject.crypto.subtle.generateKey({name: ALGORITHM, length: KEY_LENGTH },
        // `true` means that the key can be extracted from the CryptoKey object.
        true,
        // Usages for the key.
        ["encrypt", "decrypt"]
      ).then(function(cryptoKey) {
        // Now extract the key in the JSON web key format.
        return rootObject.crypto.subtle.exportKey(KEY_FORMAT, cryptoKey);
      }).then(function(exportedKey) {
        // Lastly resolve the promise with the new key.
        resolve(exportedKey.k);
      }).catch(function(error) {
        reject(error);
      });
    });
  }

  /**
   * Encrypts an object using the specified key.
   *
   * @param {String} key      The key to use for encryption. This should have
   *                          been generated by generateKey.
   * @param {String} data     The string to be encrypted.
   *
   * @return {Promise} A promise which is rejected on failure, or resolved
   *                   with a string that is the encrypted context.
   */
  function encryptBytes(key, data) {
    if (!isSupported()) {
      throw new Error("Web Crypto is not supported");
    }

    var iv = new Uint8Array(INITIALIZATION_VECTOR_LENGTH);

    return new Promise(function(resolve, reject) {
      // First import the key to a format we can use.
      rootObject.crypto.subtle.importKey(KEY_FORMAT,
        {k: key, kty: KEY_TYPE},
        ALGORITHM,
        // If the key is extractable.
        true,
        // What we're using it for.
        ["encrypt"]
      ).then(function(cryptoKey) {
        // Now we've got the cryptoKey, we can do the actual encryption.

        // First get the data into the format we need.
        var dataBuffer = sharedUtils.strToUint8Array(data);

        // It is critically important to change the IV any time the
        // encrypted information is updated.
        rootObject.crypto.getRandomValues(iv);

        return rootObject.crypto.subtle.encrypt({
            name: ALGORITHM,
            iv: iv,
            tagLength: ENCRYPT_TAG_LENGTH
          }, cryptoKey,
          dataBuffer);
      }).then(function(cipherText) {
        // Join the initialization vector and context for returning.
        var joinedData = _mergeIVandCipherText(iv, new DataView(cipherText));

        // Now convert to a string and base-64 encode.
        var encryptedData = loop.shared.utils.btoa(joinedData);

        resolve(encryptedData);
      }).catch(function(error) {
        reject(error);
      });
    });
  }

  /**
   * Decrypts an object using the specified key.
   *
   * @param {String} key           The key to use for encryption. This should have
   *                               been generated by generateKey.
   * @param {String} encryptedData The encrypted context.
   * @return {Promise} A promise which is rejected on failure, or resolved
   *                   with a string that is the decrypted context.
   */
  function decryptBytes(key, encryptedData) {
    if (!isSupported()) {
      throw new Error("Web Crypto is not supported");
    }

    return new Promise(function(resolve, reject) {
      // First import the key to a format we can use.
      rootObject.crypto.subtle.importKey(KEY_FORMAT,
        {k: key, kty: KEY_TYPE},
        ALGORITHM,
        // If the key is extractable.
        true,
        // What we're using it for.
        ["decrypt"]
      ).then(function(cryptoKey) {
        // Now we've got the key, start the decryption.
        var splitData = _splitIVandCipherText(encryptedData);

        return rootObject.crypto.subtle.decrypt({
          name: ALGORITHM,
          iv: splitData.iv,
          tagLength: ENCRYPT_TAG_LENGTH
        }, cryptoKey, splitData.cipherText);
      }).then(function(plainText) {
        // Now we just turn it back into a string and then an object.
        resolve(sharedUtils.Uint8ArrayToStr(new Uint8Array(plainText)));
      }).catch(function(error) {
        reject(error);
      });
    });
  }

  /**
   * Appends the cipher text to the end of the initialization vector and
   * returns the result.
   *
   * @param {Uint8Array} ivArray The array of initialization vector values.
   * @param {DataView} cipherTextDataView The cipherText in data view format.
   * @return {Uint8Array} An array of the IV and cipherText.
   */
  function _mergeIVandCipherText(ivArray, cipherTextDataView) {
    // First we translate the data view to an array so we can get
    // the length.
    var cipherText = new Uint8Array(cipherTextDataView.buffer);
    var cipherTextLength = cipherText.length;

    var joinedContext = new Uint8Array(INITIALIZATION_VECTOR_LENGTH + cipherTextLength);

    var i;
    for (i = 0; i < INITIALIZATION_VECTOR_LENGTH; i++) {
      joinedContext[i] = ivArray[i];
    }

    for (i = 0; i < cipherTextLength; i++) {
      joinedContext[i + INITIALIZATION_VECTOR_LENGTH] = cipherText[i];
    }

    return joinedContext;
  }

  /**
   * Takes the IV from the start of the passed in array and separates
   * out the cipher text.
   *
   * @param {String} encryptedData Encrypted data in base64 format.
   * @return {Object} An object consisting of two items: iv and cipherText,
   *                  both are Uint8Arrays.
   */
  function _splitIVandCipherText(encryptedData) {
    // Convert into byte arrays.
    var encryptedDataArray = loop.shared.utils.atob(encryptedData);

    // Now split out the initialization vector and the cipherText.
    var iv = encryptedDataArray.slice(0, INITIALIZATION_VECTOR_LENGTH);
    var cipherText = encryptedDataArray.slice(INITIALIZATION_VECTOR_LENGTH,
                                              encryptedDataArray.length);

    return {
      iv: iv,
      cipherText: cipherText
    };
  }

  return {
    decryptBytes: decryptBytes,
    encryptBytes: encryptBytes,
    generateKey: generateKey,
    isSupported: isSupported,
    setRootObject: setRootObject
  };
})();
