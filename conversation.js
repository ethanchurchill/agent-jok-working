const AssistantV2 = require('ibm-watson/assistant/v2');
const { IamAuthenticator } = require('ibm-watson/auth');
const assistantParams = require('./assistantParams.json');
const { logExpression } = require('@cisl/zepto-logger');

const assistant = new AssistantV2({
  version: assistantParams.version,
  authenticator: new IamAuthenticator({
    apikey: assistantParams.apikey
  }),
  url: assistantParams.url,
  headers: {
    'X-Watson-Learning-Opt-Out': 'true'
  }
});

let GLOBAL_sessionID = null;

function createSessionId(assistantId) {
  logExpression("About to call assistant.createSession.", 2);
  return assistant.createSession({assistantId})
  .then(sessionData => {
    logExpression("Created session with data: ", 2);
    logExpression(sessionData, 2);
    return sessionData.result.session_id;
  })
  .catch(err => {
    logExpression("Unfortunately, the call to createSession produced this error: ", 2);
    logExpression(err, 2);
    return null;
  });
}

function classifyMessage(input) {
  logExpression("Entered classifyMessage with input: ", 2);
  logExpression(input, 2);
  let assistantId = assistantParams.assistantId;
  let text = null;
  if (input.text) text = input.text.replace(/[\t\r\n]+/g," ").trim();

  let assistantMessageParams = {assistantId: assistantId, input: {}};
  if (text) {
    assistantMessageParams.input = {
      message_type: "text",
      "text": text,
      "options": {
        "alternate_intents": true,
        "return_context": true
      }
    };
    assistantMessageParams.sessionId = GLOBAL_sessionID;
  }
  logExpression("assistantMessageParams: ", 2);
  logExpression(assistantMessageParams, 2);

  return assistant.message(assistantMessageParams)
  .then(response => {
    return translateWatsonResponse(response, input);
  })
  .catch(err => {
    logExpression("Invalid sessionId: " + assistantMessageParams.sessionId, 2);
    logExpression(err, 2);
    logExpression("Try to create a new session for assistantId " + assistantId + ".", 2);
    return createSessionId(assistantId)
    .then(sessionId => {
      assistantMessageParams.sessionId = sessionId;
      GLOBAL_sessionID = sessionId;

      return assistant.message(assistantMessageParams)
      .then(response => {
        return translateWatsonResponse(response, input);
      })
      .catch(err => {
        logExpression("Got error from Watson Assistant on second attempt: ", 1);
        logExpression(err, 1);
        return err;
      });
    })
    .catch(e => {
      logExpression("Error creating sessionId for assistantId " + assistantId, 2);
      logExpression(e, 2);
    });
  });
}

function translateWatsonResponse(response, input) {
  let result = response.result;
  let output = result.output || {};

  output.input = input;
  output.addressee = input.addressee;
  output.speaker = input.speaker;

  return output;
}

exports = module.exports = {
  classifyMessage
};
