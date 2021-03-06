var util = require('util');
var fs = require('fs');
var http = require('http');
var path = require('path');
var os = require('os');
var child_process = require('child_process');
var sparta_utils = require('./sparta_utils');
var AWS = require('aws-sdk');
var awsConfig = new AWS.Config({});

var GOLANG_CONSTANTS = require('./golang-constants.json');

//TODO: See if https://forums.aws.amazon.com/message.jspa?messageID=633802
// has been updated with new information
process.env.PATH = process.env.PATH + ':/var/task';

// These two names will be dynamically reassigned during archive creation
var SPARTA_BINARY_NAME = 'Sparta.lambda.amd64';
var SPARTA_SERVICE_NAME = 'SpartaService';
// End dynamic reassignment

// This is where the binary will be extracted
var SPARTA_BINARY_PATH = path.join('/tmp', SPARTA_BINARY_NAME);
var MAXIMUM_RESPAWN_COUNT = 5;

// Handle to the active golang process.
var golangProcess = null;
var failCount = 0;

var METRIC_NAMES = {
  CREATED : 'ProcessCreated',
  REUSED: 'ProcessReused',
  TERMINATED: 'ProcessTerminated'
};

function makeRequest(path, event, context) {
  var requestBody = {
    event: event,
    context: context
  };
  // If there is a request.event.body element, try and parse it to make
  // interacting with API Gateway a bit simpler.  The .body property
  // corresponds to the data shape set by the *.vtl templates
  if (requestBody && requestBody.event && requestBody.event.body) {
    try
    {
      requestBody.event.body = JSON.parse(requestBody.event.body);
    }
    catch (e)
    {

    }
  }
  var stringified = JSON.stringify(requestBody);
  var contentLength = Buffer.byteLength(stringified, 'utf-8');
  var options = {
    host: 'localhost',
    port: 9999,
    path: path,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': contentLength
    }
  };

  var req = http.request(options, function(res) {
    res.setEncoding('utf8');
    var body = '';
    res.on('data', function(chunk) {
      body += chunk;
    });
    res.on('end', function() {
      // Bridge the NodeJS and golang worlds by including the golang
      // HTTP status text in the error response if appropriate.  This enables
      // the API Gateway integration response to use standard golang StatusText regexp
      // matches to manage HTTP status codes.

      var responseData = {};
      var handlerError = (res.statusCode >= 400) ? new Error(body) : undefined;
      if (handlerError) {
        responseData.code = res.statusCode;
        responseData.status = GOLANG_CONSTANTS.HTTP_STATUS_TEXT[res.statusCode.toString()];
        responseData.headers = res.headers;
        responseData.error = handlerError.toString();
      }
      else {
        try {
          // TODO: Check content-type before parse attempt
          responseData = JSON.parse(body);
        } catch (e) {
          responseData = body;
        }
      }
      var err = handlerError ? new Error(JSON.stringify(responseData)) : null;
      var resp = handlerError ? null : responseData;
      context.done(err, resp);
    });
  });
  req.on('error', function(e) {
    context.done(e, null);
  });
  req.write(stringified);
  req.end();
}

var postMetricCounter = function(metricName, userCallback) {
  var namespace = util.format('Sparta/%s', SPARTA_SERVICE_NAME);

  var params = {
    MetricData: [
      {
        MetricName: metricName,
        Unit: 'Count',
        Value: 1
      },
    ],
    Namespace: namespace
  };
  var cloudwatch = new AWS.CloudWatch(awsConfig);
  var onResult = function(/*e, result */) {
    if (userCallback) {
      userCallback();
    }
  };
  cloudwatch.putMetricData(params, onResult);
};

// Move the file to /tmp to temporarily work around
// https://forums.aws.amazon.com/message.jspa?messageID=583910
var ensureGoLangBinary = function(callback)
{
    try
    {
      fs.statSync(SPARTA_BINARY_PATH);
      setImmediate(callback, null);
    }
    catch (e)
    {
      var command = util.format('cp ./%s %s; chmod +x %s',
                                SPARTA_BINARY_NAME,
                                SPARTA_BINARY_PATH,
                                SPARTA_BINARY_PATH);
      child_process.exec(command, function (err, stdout) {
        if (err)
        {
          console.error(err);
          process.exit(1);
        }
        else
        {
          sparta_utils.log(stdout.toString('utf-8'));
          // Post the
        }
        callback(err, stdout);
      });
    }
};

var createForwarder = function(path) {
  var forwardToGolangProcess = function(event, context, metricName)
  {
    if (!golangProcess) {
      ensureGoLangBinary(function() {
        sparta_utils.log(util.format('Launching %s with args: execute --signal %d', SPARTA_BINARY_PATH, process.pid));
        golangProcess = child_process.spawn(SPARTA_BINARY_PATH, ['execute', '--signal', process.pid], {});

        golangProcess.stdout.on('data', function(buf) {
          buf.toString('utf-8').split('\n').forEach(function (eachLine) {
            sparta_utils.log(eachLine);
          });
        });
        golangProcess.stderr.on('data', function(buf) {
          buf.toString('utf-8').split('\n').forEach(function (eachLine) {
            sparta_utils.log(eachLine);
          });
        });

        var terminationHandler = function(eventName) {
          return function(value) {
            var onPosted = function() {
              console.error(util.format('Sparta %s: %s\n', eventName.toUpperCase(), JSON.stringify(value)));
              failCount += 1;
              if (failCount > MAXIMUM_RESPAWN_COUNT) {
                process.exit(1);
              }
              golangProcess = null;
              forwardToGolangProcess(null, null, METRIC_NAMES.TERMINATED);
            };
            postMetricCounter(METRIC_NAMES.TERMINATED, onPosted);
          };
        };
        golangProcess.on('error', terminationHandler('error'));
        golangProcess.on('exit', terminationHandler('exit'));
        process.on('exit', function() {
          sparta_utils.log('Go process exited');
          if (golangProcess) {
            golangProcess.kill();
          }
        });
        var golangProcessReadyHandler = function() {
           sparta_utils.log('SIGUSR2 signal received');
          process.removeListener('SIGUSR2', golangProcessReadyHandler);
          forwardToGolangProcess(event, context, METRIC_NAMES.CREATED);
        };
        sparta_utils.log('Waiting for SIGUSR2 signal');
        process.on('SIGUSR2', golangProcessReadyHandler);
      });
    }
    else if (event && context)
    {
      postMetricCounter(metricName || METRIC_NAMES.REUSED);
      makeRequest(path, event, context);
    }
  };
  return forwardToGolangProcess;
};

// Log the outputs
var envSettings = {
    AWS_SDK : AWS.VERSION,
    NODE_JS: process.version,
    OS: {
      PLATFORM: os.platform(),
      RELEASE: os.release(),
      TYPE: os.type(),
      UPTIME: os.uptime()
    }
};
sparta_utils.log(envSettings);

exports.main = createForwarder('/');

// Additional golang handlers to be dynamically appended below
