/**
 * @summary This function creates a materialized view that event sources the activity of
 * git commits to a GitHub repository. A set of views are maintained for each tracked
 * GitHub project that track the number of times a set of files were contained in the
 * same commit. The resulting view attempts to find a measure of tight coupling between
 * source code files.
 *
 * @author Kenny Bastani
 */

'use strict'

var mongoClient = require('mongodb').MongoClient;
var md5 = require('md5');
var Sync = require('sync');

let mongoUri;
let cachedDb = null;

/**
 * The configurable options for this materialized view.
 *
 * @type {{VIEW_NAME: string, MATCH_THRESHOLD: number, TEMPLATE: OPTS.TEMPLATE}}
 */
var OPTS = {
    // This must be unique to each materialized view
    VIEW_NAME: "tcq",
    // The match threshold for generating a new tight coupling event
    MATCH_THRESHOLD: 2,
    // The default view for this query
    TEMPLATE: function (projectId, fileIds) {
        return {
            model: {
                projectId: projectId,
                matches: 1,
                captures: 0,
                fileIds: fileIds
            },
            viewName: OPTS.VIEW_NAME,
            createdAt: new Date(),
            updatedAt: new Date()
        }
    }
};

/**
 * The AWS Lambda event handler is the entry point to this function.
 */
exports.handler = (event, context, callback) => {
    // Enables reuse of cached database connection
    context.callbackWaitsForEmptyEventLoop = false;

    // Processes the event with a MongoDB connection
    withServices(function (db, err) {
        if (err != null) {
            callback(null, err);
        } else {
            processEvent(event, callback, db);
        }
    });
};

/**
 * This function updates the materialized view before it is persisted to the attached view store.
 *
 * @param tcq is the materialized view.
 * @returns {*}
 */
function updateView(tcq) {
    tcq.model.matches = tcq.model.matches + 1;

    // Check if matches exceeds threshold
    if (tcq.model.matches >= OPTS.MATCH_THRESHOLD) {
        // Reset counter and fire a new tight coupling event
        tcq.model.matches = 0;
        tcq.model.captures = tcq.model.captures + 1;
    }

    return tcq;
}

/**
 * The query handler is responsible for updating or inserting the materialized view for this
 * function.
 *
 * @param col is the collection context from MongoDB for query models
 * @param key is the primary key for the materialized view
 * @param callback is the callback function that handles the update/insert result
 * @returns {Function} is the function that handles the update/insert life cycle of a view
 */
function queryHandler(col, key, callback) {
    return function (err, r) {
        // Handle error
        if (err)
            callback(null, err);

        // Get the view from the db response
        var view = r.value;

        if (view != null) {
            // Apply the update to the materialized view
            col.findOneAndUpdate({_id: key}, {
                $set: {
                    model: updateView(view).model,
                    updatedAt: new Date()
                }
            }, {
                returnOriginal: false,
                upsert: false
            }, function (err, r) {
                callback(null, !err ? r.value : err);
            });
        } else {
            // Return the inserted materialized view
            col.find({_id: key})
                .limit(1)
                .next(function (err, doc) {
                    callback(null, !err ? doc : err);
                });
        }
    }
}
/**
 * The event handler implementation for processing an AWS Lambda event invocation from Spring Boot.
 *
 * @param event is the event payload
 * @param callback is the function that provides a response back to Spring Boot
 * @param db is the MongoDB service provided from Cloud Foundry
 */
function processEvent(event, callback, db) {

    // Get the project commit details
    var project = event.project;
    var commit = event.projectEvent.payload.commit;

    // Get the files for this commit
    var files = commit.files.map(function (item) {
        return item.fileName.toLowerCase();
    });

    // Create power set of file combinations in this commit
    var fileGroups = powerSet(files.map(function (item, i) {
        return i;
    })).map(function (fileSet) {
        return fileSet.map(function(i) {
            return files[i];
        });
    });

    // Get the collection for query models
    var col = db.collection('query');

    function updateViewForSet(fileGroups, complete) {

        fileGroups.forEach(function(fileNames) {
            // Generates a unique MD5 hash for a combination of files
            var compositeKey = [OPTS.VIEW_NAME, project.projectId, md5(fileNames.sort().join("_"))].join("_");

            // Get or insert the materialized view for the composite key
            col.findOneAndUpdate({_id: compositeKey}, {
                $set: OPTS.TEMPLATE(project.projectId, files)
            }, {
                new: false,
                upsert: true,
                returnOriginal: true
            }, queryHandler(col, compositeKey, complete));
        });
    }

    // Views should be processed synchronously to prevent partial failure
    Sync(function () {
        var task;

        // Synchronously update the view using the event payload
        fileGroups.forEach(function(fileNames) {
            updateViewForSet(fileGroups, task = new Sync.Future());
        });

        callback(null, task.result);
    });
}


/**
 * Wrapper function for providing Cloud Foundry data service context to an AWS Lambda function.
 */
function withServices(callback) {
    initializeDataSource(callback);
}

/**
 * Initializes and caches the MongoDB connection provided by Cloud Foundry.
 */
function initializeDataSource(callback) {
    if (mongoUri == null) {
        // Fetch credentials from environment
        mongoUri = JSON.parse(process.env.SERVICE_CREDENTIALS).uri;

        // Cache database connection
        mongoClient.connect(mongoUri, function (err, db) {
            if (err == null) {
                console.log("Connected successfully to MongoDB server");
                cachedDb = db;
                callback(cachedDb);
            } else {
                console.log("Could not connect to MongoDB server: " + err);
                callback(null, err);
            }
        });
    } else {
        callback(cachedDb);
    }
}

/**
 * Power set implementation for JavaScript
 *
 * https://codereview.stackexchange.com/a/39747
 * @param list
 * @returns {Array}
 */
function powerSet(list) {
    var set = [],
        listSize = list.length,
        combinationsCount = (1 << listSize);
    for (var i = 1; i < combinationsCount; i++) {
        var combination = [];
        for (var j = 0; j < listSize; j++) {
            if ((i & (1 << j))) {
                combination.push(list[j]);
            }
        }
        set.push(combination);
    }
    return set;
}