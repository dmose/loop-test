/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "console",
                                  "resource://gre/modules/devtools/shared/Console.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "LoopStorage",
                                  "resource:///modules/loop/LoopStorage.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "Promise",
                                  "resource://gre/modules/Promise.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "CardDavImporter",
                                  "resource:///modules/loop/CardDavImporter.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "GoogleImporter",
                                  "resource:///modules/loop/GoogleImporter.jsm");
XPCOMUtils.defineLazyGetter(this, "eventEmitter", function() {
  const {EventEmitter} = Cu.import("resource://gre/modules/devtools/shared/event-emitter.js", {});
  return new EventEmitter();
});

this.EXPORTED_SYMBOLS = ["LoopContacts"];

const kObjectStoreName = "contacts";

/*
 * The table used to store contacts information contains two identifiers,
 * both of which can be used to look up entries in the table. The table
 * key path (primary index, which must be unique) is "_guid", and is
 * automatically generated by IndexedDB when an entry is first inserted.
 * The other identifier, "id", is the supposedly unique key assigned to this
 * entry by whatever service generated it (e.g., Google Contacts). While
 * this key should, in theory, be completely unique, we don't use it
 * as the key path to avoid generating errors when an external database
 * violates this constraint. This second ID is referred to as the "serviceId".
 */
const kKeyPath = "_guid";
const kServiceIdIndex = "id";

/**
 * Contacts validation.
 *
 * To allow for future integration with the Contacts API and/ or potential
 * integration with contact synchronization across devices (including Firefox OS
 * devices), we are using objects with properties having the same names and
 * structure as those used by mozContact.
 *
 * See https://developer.mozilla.org/en-US/docs/Web/API/mozContact for more
 * information.
 */
const kFieldTypeString = "string";
const kFieldTypeNumber = "number";
const kFieldTypeNumberOrString = "number|string";
const kFieldTypeArray = "array";
const kFieldTypeBool = "boolean";
const kContactFields = {
  "id": {
    // Because "id" is externally generated, it might be numeric
    type: kFieldTypeNumberOrString
  },
  "published": {
    // mozContact, from which we are derived, defines dates as
    // "a Date object, which will eventually be converted to a
    // long long" -- to be forwards compatible, we allow both
    // formats for now.
    type: kFieldTypeNumberOrString
  },
  "updated": {
    // mozContact, from which we are derived, defines dates as
    // "a Date object, which will eventually be converted to a
    // long long" -- to be forwards compatible, we allow both
    // formats for now.
    type: kFieldTypeNumberOrString
  },
  "bday": {
    // mozContact, from which we are derived, defines dates as
    // "a Date object, which will eventually be converted to a
    // long long" -- to be forwards compatible, we allow both
    // formats for now.
    type: kFieldTypeNumberOrString
  },
  "blocked": {
    type: kFieldTypeBool
  },
  "adr": {
    type: kFieldTypeArray,
    contains: {
      "countryName": {
        type: kFieldTypeString
      },
      "locality": {
        type: kFieldTypeString
      },
      "postalCode": {
        // In some (but not all) locations, postal codes can be strictly numeric
        type: kFieldTypeNumberOrString
      },
      "pref": {
        type: kFieldTypeBool
      },
      "region": {
        type: kFieldTypeString
      },
      "streetAddress": {
        type: kFieldTypeString
      },
      "type": {
        type: kFieldTypeArray,
        contains: kFieldTypeString
      }
    }
  },
  "email": {
    type: kFieldTypeArray,
    contains: {
      "pref": {
        type: kFieldTypeBool
      },
      "type": {
        type: kFieldTypeArray,
        contains: kFieldTypeString
      },
      "value": {
        type: kFieldTypeString
      }
    }
  },
  "tel": {
    type: kFieldTypeArray,
    contains: {
      "pref": {
        type: kFieldTypeBool
      },
      "type": {
        type: kFieldTypeArray,
        contains: kFieldTypeString
      },
      "value": {
        type: kFieldTypeString
      }
    }
  },
  "name": {
    type: kFieldTypeArray,
    contains: kFieldTypeString
  },
  "honorificPrefix": {
    type: kFieldTypeArray,
    contains: kFieldTypeString
  },
  "givenName": {
    type: kFieldTypeArray,
    contains: kFieldTypeString
  },
  "additionalName": {
    type: kFieldTypeArray,
    contains: kFieldTypeString
  },
  "familyName": {
    type: kFieldTypeArray,
    contains: kFieldTypeString
  },
  "honorificSuffix": {
    type: kFieldTypeArray,
    contains: kFieldTypeString
  },
  "category": {
    type: kFieldTypeArray,
    contains: kFieldTypeString
  },
  "org": {
    type: kFieldTypeArray,
    contains: kFieldTypeString
  },
  "jobTitle": {
    type: kFieldTypeArray,
    contains: kFieldTypeString
  },
  "note": {
    type: kFieldTypeArray,
    contains: kFieldTypeString
  }
};

/**
 * Compares the properties contained in an object to the definition as defined in
 * `kContactFields`.
 * If a property is encountered that is not found in the spec, an Error is thrown.
 * If a property is encountered with an invalid value, an Error is thrown.
 *
 * Please read the spec at https://wiki.mozilla.org/Loop/Architecture/Address_Book
 * for more information.
 *
 * @param {Object} obj The contact object, or part of it when called recursively
 * @param {Object} def The definition of properties to validate against. Defaults
 *                     to `kContactFields`
 */
const validateContact = function(obj, def = kContactFields) {
  for (let propName of Object.getOwnPropertyNames(obj)) {
    // Ignore internal properties.
    if (propName.startsWith("_")) {
      continue;
    }

    let propDef = def[propName];
    if (!propDef) {
      throw new Error("Field '" + propName + "' is not supported for contacts");
    }

    let val = obj[propName];

    switch (propDef.type) {
      case kFieldTypeString:
        if (typeof val != kFieldTypeString) {
          throw new Error("Field '" + propName + "' must be of type String");
        }
        break;
      case kFieldTypeNumberOrString:
        let type = typeof val;
        if (type != kFieldTypeNumber && type != kFieldTypeString) {
          throw new Error("Field '" + propName + "' must be of type Number or String");
        }
        break;
      case kFieldTypeBool:
        if (typeof val != kFieldTypeBool) {
          throw new Error("Field '" + propName + "' must be of type Boolean");
        }
        break;
      case kFieldTypeArray:
        if (!Array.isArray(val)) {
          throw new Error("Field '" + propName + "' must be an Array");
        }

        let contains = propDef.contains;
        // If the type of `contains` is a scalar value, it means that the array
        // consists of items of only that type.
        let isScalarCheck = (typeof contains == kFieldTypeString);
        for (let arrayValue of val) {
          if (isScalarCheck) {
            if (typeof arrayValue != contains) {
              throw new Error("Field '" + propName + "' must be of type " + contains);
            }
          } else {
            validateContact(arrayValue, contains);
          }
        }
        break;
    }
  }
};

/**
 * Provides a method to perform multiple operations in a single transaction on the
 * contacts store.
 *
 * @param {String}   operation Name of an operation supported by `IDBObjectStore`
 * @param {Array}    data      List of objects that will be passed to the object
 *                             store operation
 * @param {Function} callback  Function that will be invoked once the operations
 *                             have finished. The first argument passed will be
 *                             an `Error` object or `null`. The second argument
 *                             will be the `data` Array, if all operations finished
 *                             successfully.
 */
const batch = function(operation, data, callback) {
  let processed = [];
  if (!LoopContactsInternal.hasOwnProperty(operation) ||
    typeof LoopContactsInternal[operation] != "function") {
    callback(new Error("LoopContactsInternal does not contain a '" +
             operation + "' method"));
    return;
  }
  LoopStorage.asyncForEach(data, (item, next) => {
    LoopContactsInternal[operation](item, (err, result) => {
      if (err) {
        next(err);
        return;
      }
      processed.push(result);
      next();
    });
  }, err => {
    if (err) {
      callback(err, processed);
      return;
    }
    callback(null, processed);
  });
};

/**
 * Extend a `target` object with the properties defined in `source`.
 *
 * @param {Object} target The target object to receive properties defined in `source`
 * @param {Object} source The source object to copy properties from
 */
const extend = function(target, source) {
  for (let key of Object.getOwnPropertyNames(source)) {
    target[key] = source[key];
  }
  return target;
};

LoopStorage.on("upgrade", function(e, db) {
  if (db.objectStoreNames.contains(kObjectStoreName)) {
    return;
  }

  // Create the 'contacts' store as it doesn't exist yet.
  let store = db.createObjectStore(kObjectStoreName, {
    keyPath: kKeyPath,
    autoIncrement: true
  });
  store.createIndex(kServiceIdIndex, kServiceIdIndex, {unique: false});
});

/**
 * The Contacts class.
 *
 * Each method that is a member of this class requires the last argument to be a
 * callback Function. MozLoopAPI will cause things to break if this invariant is
 * violated. You'll notice this as well in the documentation for each method.
 */
var LoopContactsInternal = Object.freeze({
  /**
   * Map of contact importer names to instances
   */
  _importServices: {
    "carddav": new CardDavImporter(),
    "google": new GoogleImporter()
  },

  /**
   * Add a contact to the data store.
   *
   * @param {Object}   details  An object that will be added to the data store
   *                            as-is. Please read https://wiki.mozilla.org/Loop/Architecture/Address_Book
   *                            for more information of this objects' structure
   * @param {Function} callback Function that will be invoked once the operation
   *                            finished. The first argument passed will be an
   *                            `Error` object or `null`. The second argument will
   *                            be the contact object, if it was stored successfully.
   */
  add: function(details, callback) {
    if (!(kServiceIdIndex in details)) {
      callback(new Error("No '" + kServiceIdIndex + "' field present"));
      return;
    }
    try {
      validateContact(details);
    } catch (ex) {
      callback(ex);
      return;
    }

    LoopStorage.getStore(kObjectStoreName, (err, store) => {
      if (err) {
        callback(err);
        return;
      }

      let contact = extend({}, details);
      let now = Date.now();
      // The data source should have included "published" and "updated" values
      // for any imported records, and we need to keep track of those dated for
      // sync purposes (i.e., when we add functionality to push local changes to
      // a remote server from which we originally got a contact). We also need
      // to track the time at which *we* added and most recently changed the
      // contact, so as to determine whether the local or the remote store has
      // fresher data.
      //
      // For clarity: the fields "published" and "updated" indicate when the
      // *remote* data source published and updated the contact. The fields
      // "_date_add" and "_date_lch" track when the *local* data source
      // created and updated the contact.
      contact.published = contact.published ? new Date(contact.published).getTime() : now;
      contact.updated = contact.updated ? new Date(contact.updated).getTime() : now;
      contact._date_add = contact._date_lch = now;

      let request;
      try {
        request = store.add(contact);
      } catch (ex) {
        callback(ex);
        return;
      }

      request.onsuccess = event => {
        contact[kKeyPath] = event.target.result;
        eventEmitter.emit("add", contact);
        callback(null, contact);
      };

      request.onerror = event => callback(event.target.error);
    }, "readwrite");
  },

  /**
   * Add a batch of contacts to the data store.
   *
   * @param {Array}    contacts A list of contact objects to be added
   * @param {Function} callback Function that will be invoked once the operation
   *                            finished. The first argument passed will be an
   *                            `Error` object or `null`. The second argument will
   *                            be the list of added contacts.
   */
  addMany: function(contacts, callback) {
    batch("add", contacts, callback);
  },

  /**
   * Remove a contact from the data store.
   *
   * @param {String}   guid     String identifier of the contact to remove
   * @param {Function} callback Function that will be invoked once the operation
   *                            finished. The first argument passed will be an
   *                            `Error` object or `null`. The second argument will
   *                            be the result of the operation.
   */
  remove: function(guid, callback) {
    this.get(guid, (err, contact) => {
      if (err) {
        callback(err);
        return;
      }

      LoopStorage.getStore(kObjectStoreName, (error, store) => {
        if (error) {
          callback(error);
          return;
        }

        let request;
        try {
          request = store.delete(guid);
        } catch (ex) {
          callback(ex);
          return;
        }

        request.onsuccess = event => {
          if (contact) {
            eventEmitter.emit("remove", contact);
          }
          callback(null, event.target.result);
        };
        request.onerror = event => callback(event.target.error);
      }, "readwrite");
    });
  },

  /**
   * Remove a batch of contacts from the data store.
   *
   * @param {Array}    guids    A list of IDs of the contacts to remove
   * @param {Function} callback Function that will be invoked once the operation
   *                            finished. The first argument passed will be an
   *                            `Error` object or `null`. The second argument will
   *                            be the list of IDs, if successfull.
   */
  removeMany: function(guids, callback) {
    batch("remove", guids, callback);
  },

  /**
   * Remove _all_ contacts from the data store.
   * CAUTION: this method will clear the whole data store - you won't have any
   *          contacts left!
   *
   * @param {Function} callback Function that will be invoked once the operation
   *                            finished. The first argument passed will be an
   *                            `Error` object or `null`. The second argument will
   *                            be the result of the operation, if successfull.
   */
  removeAll: function(callback) {
    LoopStorage.getStore(kObjectStoreName, (err, store) => {
      if (err) {
        callback(err);
        return;
      }

      let request;
      try {
        request = store.clear();
      } catch (ex) {
        callback(ex);
        return;
      }

      request.onsuccess = event => {
        eventEmitter.emit("removeAll", event.target.result);
        callback(null, event.target.result);
      };
      request.onerror = event => callback(event.target.error);
    }, "readwrite");
  },

  /**
   * Retrieve a specific contact from the data store.
   *
   * @param {String}   guid     String identifier of the contact to retrieve
   * @param {Function} callback Function that will be invoked once the operation
   *                            finished. The first argument passed will be an
   *                            `Error` object or `null`. The second argument will
   *                            be the contact object, if successful.
   *                            If no object matching guid could be found,
   *                            then the callback is called with both arguments
   *                            set to `null`.
   */
  get: function(guid, callback) {
    LoopStorage.getStore(kObjectStoreName, (err, store) => {
      if (err) {
        callback(err);
        return;
      }

      let request;
      try {
        request = store.get(guid);
      } catch (ex) {
        callback(ex);
        return;
      }

      request.onsuccess = event => {
        if (!event.target.result) {
          callback(null, null);
          return;
        }
        let contact = extend({}, event.target.result);
        contact[kKeyPath] = guid;
        callback(null, contact);
      };
      request.onerror = event => callback(event.target.error);
    });
  },

  /**
   * Retrieve a specific contact from the data store using the kServiceIdIndex
   * property.
   *
   * @param {String}   serviceId String identifier of the contact to retrieve
   * @param {Function} callback  Function that will be invoked once the operation
   *                             finished. The first argument passed will be an
   *                             `Error` object or `null`. The second argument will
   *                             be the contact object, if successfull.
   *                             If no object matching serviceId could be found,
   *                             then the callback is called with both arguments
   *                             set to `null`.
   */
  getByServiceId: function(serviceId, callback) {
    LoopStorage.getStore(kObjectStoreName, (err, store) => {
      if (err) {
        callback(err);
        return;
      }

      let index = store.index(kServiceIdIndex);
      let request;
      try {
        request = index.get(serviceId);
      } catch (ex) {
        callback(ex);
        return;
      }

      request.onsuccess = event => {
        if (!event.target.result) {
          callback(null, null);
          return;
        }

        let contact = extend({}, event.target.result);
        callback(null, contact);
      };
      request.onerror = event => callback(event.target.error);
    });
  },

  /**
   * Retrieve _all_ contacts from the data store.
   * CAUTION: If the amount of contacts is very large (say > 100000), this method
   *          may slow down your application!
   *
   * @param {Function} callback Function that will be invoked once the operation
   *                            finished. The first argument passed will be an
   *                            `Error` object or `null`. The second argument will
   *                            be an `Array` of contact objects, if successfull.
   */
  getAll: function(callback) {
    LoopStorage.getStore(kObjectStoreName, (err, store) => {
      if (err) {
        callback(err);
        return;
      }

      let cursorRequest = store.openCursor();
      let contactsList = [];

      cursorRequest.onsuccess = event => {
        let cursor = event.target.result;
        // No more results, return the list.
        if (!cursor) {
          callback(null, contactsList);
          return;
        }

        let contact = extend({}, cursor.value);
        contact[kKeyPath] = cursor.key;
        contactsList.push(contact);

        cursor.continue();
      };

      cursorRequest.onerror = event => callback(event.target.error);
    });
  },

  /**
   * Retrieve an arbitrary amount of contacts from the data store.
   * CAUTION: If the amount of contacts is very large (say > 1000), this method
   *          may slow down your application!
   *
   * @param {Array}    guids    List of contact IDs to retrieve contact objects of
   * @param {Function} callback Function that will be invoked once the operation
   *                            finished. The first argument passed will be an
   *                            `Error` object or `null`. The second argument will
   *                            be an `Array` of contact objects, if successfull.
   */
  getMany: function(guids, callback) {
    let contacts = [];
    LoopStorage.asyncParallel(guids, (guid, next) => {
      this.get(guid, (err, contact) => {
        if (err) {
          next(err);
          return;
        }
        contacts.push(contact);
        next();
      });
    }, err => {
      callback(err, !err ? contacts : null);
    });
  },

  /**
   * Update a specific contact in the data store.
   * The contact object is modified by replacing the fields passed in the `details`
   * param and any fields not passed in are left unchanged.
   *
   * @param {Object}   details  An object that will be updated in the data store
   *                            as-is. Please read https://wiki.mozilla.org/Loop/Architecture/Address_Book
   *                            for more information of this objects' structure
   * @param {Function} callback Function that will be invoked once the operation
   *                            finished. The first argument passed will be an
   *                            `Error` object or `null`. The second argument will
   *                            be the contact object, if successfull.
   */
  update: function(details, callback) {
    if (!(kKeyPath in details)) {
      callback(new Error("No '" + kKeyPath + "' field present"));
      return;
    }
    try {
      validateContact(details);
    } catch (ex) {
      callback(ex);
      return;
    }

    let guid = details[kKeyPath];

    this.get(guid, (err, contact) => {
      if (err) {
        callback(err);
        return;
      }

      if (!contact) {
        callback(new Error("Contact with " + kKeyPath + " '" +
                           guid + "' could not be found"));
        return;
      }

      LoopStorage.getStore(kObjectStoreName, (error, store) => {
        if (error) {
          callback(error);
          return;
        }

        let previous = extend({}, contact);
        // Update the contact with properties provided by `details`.
        extend(contact, details);

        details._date_lch = Date.now();
        let request;
        try {
          request = store.put(contact);
        } catch (ex) {
          callback(ex);
          return;
        }

        request.onsuccess = event => {
          eventEmitter.emit("update", contact, previous);
          callback(null, event.target.result);
        };
        request.onerror = event => callback(event.target.error);
      }, "readwrite");
    });
  },

  /**
   * Block a specific contact in the data store.
   *
   * @param {String}   guid     String identifier of the contact to block
   * @param {Function} callback Function that will be invoked once the operation
   *                            finished. The first argument passed will be an
   *                            `Error` object or `null`. The second argument will
   *                            be the contact object, if successfull.
   */
  block: function(guid, callback) {
    this.get(guid, (err, contact) => {
      if (err) {
        callback(err);
        return;
      }

      if (!contact) {
        callback(new Error("Contact with " + kKeyPath + " '" +
                           guid + "' could not be found"));
        return;
      }

      contact.blocked = true;
      this.update(contact, callback);
    });
  },

  /**
   * Un-block a specific contact in the data store.
   *
   * @param {String}   guid     String identifier of the contact to unblock
   * @param {Function} callback Function that will be invoked once the operation
   *                            finished. The first argument passed will be an
   *                            `Error` object or `null`. The second argument will
   *                            be the contact object, if successfull.
   */
  unblock: function(guid, callback) {
    this.get(guid, (err, contact) => {
      if (err) {
        callback(err);
        return;
      }

      if (!contact) {
        callback(new Error("Contact with " + kKeyPath + " '" +
                           guid + "' could not be found"));
        return;
      }

      contact.blocked = false;
      this.update(contact, callback);
    });
  },

  /**
   * Import a list of (new) contacts from an external data source.
   *
   * @param {Object}   options  Property bag of options for the importer
   * @param {Function} callback Function that will be invoked once the operation
   *                            finished. The first argument passed will be an
   *                            `Error` object or `null`. The second argument will
   *                            be the result of the operation, if successfull.
   */
  startImport: function(options, windowRef, callback) {
    if (!("service" in options)) {
      callback(new Error("No import service specified in options"));
      return;
    }
    if (!(options.service in this._importServices)) {
      callback(new Error("Unknown import service specified: " + options.service));
      return;
    }
    this._importServices[options.service].startImport(options, callback,
                                                      LoopContacts, windowRef);
  },

  /**
   * Search through the data store for contacts that match a certain (sub-)string.
   * NB: The current implementation is very simple, naive if you will; we fetch
   *     _all_ the contacts via `getAll()` and iterate over all of them to find
   *     the contacts matching the supplied query (brute-force search in
   *     exponential time).
   *
   * @param {Object}   query    Needle to search for in our haystack of contacts
   * @param {Function} callback Function that will be invoked once the operation
   *                            finished. The first argument passed will be an
   *                            `Error` object or `null`. The second argument will
   *                            be an `Array` of contact objects, if successfull.
   *
   * Example:
   *   LoopContacts.search({
   *     q: "foo@bar.com",
   *     field: "email" // 'email' is the default.
   *   }, function(err, contacts) {
   *     if (err) {
   *       throw err;
   *     }
   *     console.dir(contacts);
   *   });
   */
  search: function(query, callback) {
    if (!("q" in query) || !query.q) {
      callback(new Error("Nothing to search for. 'q' is required."));
      return;
    }
    if (!("field" in query)) {
      query.field = "email";
    }
    let queryValue = query.q;
    if (query.field == "tel") {
      queryValue = queryValue.replace(/[\D]+/g, "");
    }

    const checkForMatch = function(fieldValue) {
      if (typeof fieldValue == "string") {
        if (query.field == "tel") {
          return fieldValue.replace(/[\D]+/g, "").endsWith(queryValue);
        }
        return fieldValue == queryValue;
      }
      if (typeof fieldValue == "number" || typeof fieldValue == "boolean") {
        return fieldValue == queryValue;
      }
      if ("value" in fieldValue) {
        return checkForMatch(fieldValue.value);
      }
      return false;
    };

    let foundContacts = [];
    this.getAll((err, contacts) => {
      if (err) {
        callback(err);
        return;
      }

      for (let contact of contacts) {
        let matchWith = contact[query.field];
        if (!matchWith) {
          continue;
        }

        // Many fields are defined as Arrays.
        if (Array.isArray(matchWith)) {
          for (let fieldValue of matchWith) {
            if (checkForMatch(fieldValue)) {
              foundContacts.push(contact);
              break;
            }
          }
        } else if (checkForMatch(matchWith)) {
          foundContacts.push(contact);
        }
      }

      callback(null, foundContacts);
    });
  }
});

/**
 * Public Loop Contacts API.
 *
 * LoopContacts implements the EventEmitter interface by exposing three methods -
 * `on`, `once` and `off` - to subscribe to events.
 * At this point the following events may be subscribed to:
 *  - 'add':       A new contact object was successfully added to the data store.
 *  - 'remove':    A contact was successfully removed from the data store.
 *  - 'removeAll': All contacts were successfully removed from the data store.
 *  - 'update':    A contact object was successfully updated with changed
 *                 properties in the data store.
 */
this.LoopContacts = Object.freeze({
  add: function(details, callback) {
    return LoopContactsInternal.add(details, callback);
  },

  addMany: function(contacts, callback) {
    return LoopContactsInternal.addMany(contacts, callback);
  },

  remove: function(guid, callback) {
    return LoopContactsInternal.remove(guid, callback);
  },

  removeMany: function(guids, callback) {
    return LoopContactsInternal.removeMany(guids, callback);
  },

  removeAll: function(callback) {
    return LoopContactsInternal.removeAll(callback);
  },

  get: function(guid, callback) {
    return LoopContactsInternal.get(guid, callback);
  },

  getByServiceId: function(serviceId, callback) {
    return LoopContactsInternal.getByServiceId(serviceId, callback);
  },

  getAll: function(callback) {
    return LoopContactsInternal.getAll(callback);
  },

  getMany: function(guids, callback) {
    return LoopContactsInternal.getMany(guids, callback);
  },

  update: function(details, callback) {
    return LoopContactsInternal.update(details, callback);
  },

  block: function(guid, callback) {
    return LoopContactsInternal.block(guid, callback);
  },

  unblock: function(guid, callback) {
    return LoopContactsInternal.unblock(guid, callback);
  },

  startImport: function(options, windowRef, callback) {
    return LoopContactsInternal.startImport(options, windowRef, callback);
  },

  search: function(query, callback) {
    return LoopContactsInternal.search(query, callback);
  },

  promise: function(method, ...params) {
    return new Promise((resolve, reject) => {
      this[method](...params, (error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      });
    });
  },

  on: (...params) => eventEmitter.on(...params),

  once: (...params) => eventEmitter.once(...params),

  off: (...params) => eventEmitter.off(...params)
});
