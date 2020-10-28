const envLoaded = require('dotenv').load({silent: true});
if (!envLoaded) console.log('warning:', __filename, '.env cannot be found');

const appSettings = require('./appSettings.json');
const http = require('http');
const express = require('express');
let request = require('request-promise');
const { logExpression, setLogLevel } = require('@cisl/zepto-logger');
// logExpression is like console.log, but it also
//   * outputs a timestamp
//   * first argument takes text or JSON and handles it appropriately
//   * second numeric argument establishes the logging priority: 1: high, 2: moderate, 3: low
//   * logging priority n is set by -level n option on command line when agent-jok is started

let methodOverride = require('method-override');
let bodyParser = require('body-parser');

const {classifyMessage} = require('./conversation.js');
const {extractBidFromMessage, interpretMessage} = require('./extract-bid.js');
const argv = require('minimist')(process.argv.slice(2));

let myPort = argv.port || appSettings.defaultPort || 14007;
let agentName = appSettings.name || "Agent007";

const defaultRole = 'buyer';
const defaultSpeaker = 'Jeff';
const defaultAddressee = agentName;
const defaultRoundDuration = 600;
const defaultRoundId = 0;

let roundId;

const rejectionMessages = [
  "No thanks. Your offer is much too low for me to consider.",
  "Forget it. That's not a serious offer.",
  "Sorry. You're going to have to do a lot better than that!",
  "I'm afraid that offer isn't going to cut it.",
  "Sorry, but that is too low of an offer.",
  "No thanks. Your offer is not high enough.",
  "No deal!",
  "I can't accept such a low price.",
  "That offer won't work for me.",
  "No thanks, I can't sell for that low.",
  "That offer is ridiculous! No deal!",
  "Unfortunately that's too low for me."
];

const acceptanceMessages = [
  "You've got a deal! I'll sell you",
  "You've got it! I'll let you have",
  "I accept your offer. Just to confirm, I'll give you",
  "Yeah that's it! I'll part with",
  "I'll accept that offer for",
  "Great! I'll sell you",
  "Perfect, I'll sell you",
  "That's a fine price for",
  "Okay! I'll give you",
];

const confirmAcceptanceMessages = [
  "I confirm that I'm selling you ",
  "I'm so glad! This is to confirm that I'll give you ",
  "Perfect! Just to confirm, I'm giving you ",
  "Okay! I'm selling you ",
  "You got it! I'm selling you ",
  "Great! To confirm, I'm giving you ",
  "Awesome, I'm giving you ",
  "Just to confirm, thats ",
  "Okay! I'll give you"
];

let negotiationState = {
  "active": false,
  "startTime": null,
  "roundDuration": defaultRoundDuration
};

let polite = false; // Set to true to force agent to only respond to offers addressed to it; false will yield rude behavior
let logLevel = 1;

if (argv.level) {
  logLevel = argv.level;
  logExpression(`Setting log level to ${logLevel}`, 1);
}
setLogLevel(logLevel);

if (argv.polite) {
  if (argv.polite.toLowerCase() === 'false') {
    polite = false;
  }
  logExpression(`Setting politeness to ${polite}`, 2);
}

const app = express();

app.set('port', process.env.PORT || myPort);
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(methodOverride());

let utilityInfo = null;
let bidHistory;


// ************************************************************************************************************ //
// REQUIRED APIs
// ************************************************************************************************************ //

// API route that receives utility information from the environment orchestrator. This also
// triggers the start of a round and the associated timer.
app.post('/setUtility', (req, res) => {
  logExpression("Inside setUtility (POST).", 2);
  if(req.body) {
    roundId = req.body.roundId;
    utilityInfo = req.body;
    logExpression("Received utilityInfo: ", 2);
    logExpression(utilityInfo, 2);
    agentName = utilityInfo.name || agentName;
    logExpression("agentName: " + agentName, 2);
    let msg = {roundId, "status": "Acknowledged", "utility": utilityInfo};
    logExpression(msg, 2);
    res.json(msg);
  }
  else {
    let msg = {"status": "Failed; no message body", "utility": null};
    logExpression(msg, 2);
    res.json(msg);
  }
});

// API route that tells the agent that the round has started.
app.post('/startRound', (req, res) => {
  logExpression("Inside startRound (POST).", 2);
  bidHistory = {};
  if(req.body) {
    negotiationState.roundDuration = req.body.roundDuration || negotiationState.roundDuration;
    negotiationState.roundId = req.body.roundId || negotiationState.roundId;
  }
  negotiationState.active = true;
  negotiationState.startTime = new Date();
  negotiationState.stopTime = new Date(negotiationState.startTime.getTime() + 1000 * negotiationState.roundDuration);
  logExpression("Negotiation state is: ", 2);
  logExpression(negotiationState, 2);
  let msg = {roundId, "status": "Acknowledged"};
  res.json(msg);
});

// API route that tells the agent that the round has ended.
app.post('/endRound', (req, res) => {
  logExpression("Inside endRound (POST).", 2);
  negotiationState.active = false;
  negotiationState.endTime = new Date();
  logExpression("Negotiation state is: ", 2);
  logExpression(negotiationState, 2);
  let msg = {roundId, "status": "Acknowledged"};
  res.json(msg);
});

// POST API that receives a message, interprets it, decides how to respond (e.g. Accept, Reject, or counteroffer),
// and if it desires sends a separate message to the /receiveMessage route of the environment orchestrator
app.post('/receiveMessage', (req, res) => {
  logExpression("Inside receiveMessage (POST).", 2);
  let timeRemaining = ((new Date(negotiationState.stopTime)).getTime() - (new Date()).getTime())/ 1000.0;
  logExpression("Remaining time: " + timeRemaining, 2);
  logExpression("Negotiation state: " + negotiationState.active, 2);
  logExpression("POSTed body: ", 2);
  logExpression(req.body, 2);
  if(timeRemaining <= 0) negotiationState.active = false;

  let response = null;

  if(!req.body) {
    response = {
      "status": "Failed; no message body"
    };
  }
  else if(negotiationState.active) { // We received a message and time remains in the round.
    let message = req.body;
    message.speaker = message.speaker || defaultSpeaker;
    message.addressee = message.addressee;
    message.role = message.role || message.defaultRole;
    message.roundId = message.roundId || defaultRoundId;
    response = { // Acknowledge receipt of message from the environment orchestrator
      roundId,
      status: "Acknowledged",
      interpretation: message
    };
    logExpression("Message is: ", 2);
    logExpression(message, 2);

    processMessage(message)
    .then(bidMessage => {
      logExpression("Bid message is: ", 2);
      logExpression(bidMessage, 2);
      if(bidMessage) { // If warranted, proactively send a new negotiation message to the environment orchestrator
        sendMessage(bidMessage);
      }
    })
    .catch(error => {
      logExpression("Did not send message; encountered error: ", 1);
      logExpression(error, 1);
    });
  }
  else { // Either there's no body or the round is over.
    response = {
      status: "Failed; round not active"
    };
  }
  res.json(response);
});

// POST API that receives a rejection message, and decides how to respond to it. If the rejection is based upon
// insufficient funds on the part of the buyer, generate an informational message to send back to the human, as a courtesy
// (or rather to explain why we are not able to confirm acceptance of an offer).
app.post('/receiveRejection', (req, res) => {
  logExpression("Inside receiveRejection (POST).", 2);
  let timeRemaining = ((new Date(negotiationState.stopTime)).getTime() - (new Date()).getTime())/ 1000.0;
  logExpression("Remaining time: " + timeRemaining, 2);
  logExpression("POSTed body: ", 2);
  logExpression(req.body, 2);
  if(timeRemaining <= 0) negotiationState.active = false;
  let response = null;
  if(!req.body) {
    response = {
      "status": "Failed; no message body"
    };
  }
  else if(negotiationState.active) { // We received a message and time remains in the round.
    let message = req.body;
    logExpression("Rejected message is: ", 2);
    logExpression(message, 2);
    response = { // Acknowledge receipt of message from the environment orchestrator
      roundId,
      status: "Acknowledged",
      message
    };
    if(
      message.rationale &&
      message.rationale == "Insufficient budget" &&
      message.bid &&
      message.bid.type == "Accept"
    ) { // We tried to respond with an accept, but were rejected. So that the buyer will not interpret our apparent silence as rudeness, explain to the Human that he/she were rejected due to insufficient budget.
      let msg2 = JSON.parse(JSON.stringify(message));
      delete msg2.rationale;
      delete msg2.bid;
      msg2.timestamp = new Date();
      msg2.text = "I'm sorry, " + msg2.addressee + ". I was ready to make a deal, but apparently you don't have enough money left.";
      sendMessage(msg2);
    }
  } else { // Either there's no body or the round is over.
    response = {
      status: "Failed; round not active"
    };
  }
  res.json(response);
});


// ************************************************************************************************************ //
// Non-required APIs (useful for unit testing)
// ************************************************************************************************************ //


// GET API route that simply calls Watson Assistant on the supplied text message to obtain intent and entities
app.get('/classifyMessage', (req, res) => {
  logExpression("Inside classifyMessage (GET).", 2);
  if(req.query.text) {
    let text = req.query.text;
    let message = { // Hard-code the speaker, role and envUUID
      text,
      speaker: defaultSpeaker,
      addressee: defaultAddressee,
      role: defaultRole,
      environmentUUID: defaultEnvironmentUUID
    };
    logExpression("Message is: ", 2);
    logExpression(message, 2);
    return classifyMessage(message)
    .then(waResponse => {
      waResponse.roundId = roundId;
      logExpression("Response from Watson Assistant: ", 2);
      logExpression(waResponse, 2);
      res.json(waResponse);
    });
  }
});

// POST API route that simply calls Watson Assistant on the supplied text message to obtain intents and entities
app.post('/classifyMessage', (req, res) => {
  logExpression("Inside classifyMessage (POST).", 2);
  if(req.body) {
    let message = req.body;
    message.speaker = message.speaker || defaultSpeaker;
    message.addressee = message.addressee || null;
    message.role = message.role || message.defaultRole;
    message.environmentUUID = message.environmentUUID || defaultEnvironmentUUID;
    logExpression("Message is: ", 2);
    logExpression(message, 2);
    return classifyMessage(message)
    .then(waResponse => {
      waResponse.roundId = roundId;
      logExpression("Response from Watson Assistant : ", 2);
      logExpression(waResponse, 2);
      res.json(waResponse);
    })
    .catch(err => {
      logExpression("Error from Watson Assistant: ", 2);
      logExpression(err, 2);
      res.json(err);
    });
  }
});

// POST API route that is similar to /classify Message, but takes the further
// step of determining the type and parameters of the message (if it is a negotiation act),
// and formatting this information in the form of a structured bid.
app.post('/extractBid', (req, res) => {
  logExpression("Inside extractBid (POST).", 2);
  if(req.body) {
    let message = req.body;
    message.speaker = message.speaker || defaultSpeaker;
    message.addressee = message.addressee || null;
    message.role = message.role || message.defaultRole;
    message.environmentUUID = message.environmentUUID || defaultEnvironmentUUID;
    logExpression("Message is: ", 2);
    logExpression(message, 2);
    return extractBidFromMessage(message)
    .then(extractedBid => {
      extractedBid.roundId = roundId;
      logExpression("Extracted bid : ", 2);
      logExpression(extractedBid, 2);
      res.json(extractedBid);
    })
    .catch(err => {
      logExpression("Error extracting bid: ", 2);
      logExpression(err, 2);
      res.json(err);
    });
  }
});

// API route that reports the current utility information.
app.get('/reportUtility', (req, res) => {
  logExpression("Inside reportUtility (GET).", 2);
  if(utilityInfo) {
    utilityInfo.roundId = roundId;
    res.json(utilityInfo);
  }
  else {
    res.json({"error": "utilityInfo not initialized."});
  }
});

// Set up the server in the standard Node.js way
http.createServer(app).listen(app.get('port'), () => {
  logExpression('Express server listening on port ' + app.get('port'), 2);
});


// ******************************************************************************************************* //
// ******************************************************************************************************* //
//                                               Functions
// ******************************************************************************************************* //
// ******************************************************************************************************* //


// ******************************************************************************************************* //
//                                         Bidding Algorithm Functions                                     //
// ******************************************************************************************************* //


// *** mayIRespond()
// Choose not to respond to certain buy offers or requests, either because the received offer has the wrong role
// or because a different agent is being addressed. Note that this self-censoring is stricter than required
// by competition rules, i.e. this agent is not trying to steal a deal despite this being permitted under the
// right circumstances. You can do better than this!

function mayIRespond(role, addressee) {
  if (polite) {
    return (role == "buyer" && (addressee == agentName || !addressee));
  } else {
    return true;
  }
}

// *** calculateUtilitySeller()
// Calculate utility for a given bundle of goods and price, given the utility function

function calculateUtilitySeller(utilityInfo, bundle) {
  logExpression("In calculateUtilitySeller, utilityParams and bundle are: ", 2);
  let utilityParams = utilityInfo.utility;
  logExpression(utilityParams, 2);
  logExpression(bundle, 2);

  let util = 0;
  let price = getSafe(['price', 'value'], bundle, 0);
  logExpression("Extracted price from bundle: " + price, 2);
  if(bundle.quantity) {
    util = price;
    unit = getSafe(['price', 'unit'], bundle, null);
    if(!unit) { // Check units -- not really used, but a good practice in case we want to support currency conversion some day
      logExpression("No currency units provided.", 2);
    }
    else if(unit == utilityInfo.currencyUnit) {
      logExpression("Currency units match.", 2);
    }
    else {
      logExpression("WARNING: Currency units do not match!", 2);
    }
    Object.keys(bundle.quantity).forEach(good => {
      logExpression("Good: " + good, 2);
      util -= utilityParams[good].parameters.unitcost * bundle.quantity[good];
    });
  }
  logExpression("About to return utility: " + util, 2);
  return util;
}


// *** generateBid()
// Given a received offer and some very recent prior bidding history, generate a bid
// including the type (Accept, Reject, and the terms (bundle and price).

function generateBid(offer) {
  logExpression("In generateBid, offer is: ", 2);
  logExpression(offer, 2);
  logExpression("bid history is currently: ", 3);
  logExpression(bidHistory, 3);
  let minDicker = 0.10;
  let buyerName = offer.metadata.speaker;
  let myRecentOffers = bidHistory[buyerName].filter(bidBlock => {
    return (bidBlock.type == "SellOffer");
  });
  logExpression("myRecentOffers is: ", 2);
  logExpression(myRecentOffers, 2);
  let myLastPrice = null;
  if(myRecentOffers.length) {
    myLastPrice = myRecentOffers[myRecentOffers.length-1].price.value;
    logExpression("My most recent price offer was " + myLastPrice, 2);
  }
  let timeRemaining = ((new Date(negotiationState.stopTime)).getTime() - (new Date()).getTime())/ 1000.0;
  logExpression("There are " + timeRemaining + " seconds remaining in this round.", 3);

  let utility = calculateUtilitySeller(utilityInfo, offer);
  logExpression("From calculateUtilitySeller, utility of offer is computed to be: " + utility, 2);

// Note that we are making no effort to upsell the buyer on a different package of goods than what they requested.
// It would be legal to do so, and perhaps profitable in some situations -- consider doing that!
  let bid = {quantity: offer.quantity};

  if(offer.price && offer.price.value) { // The buyer included a proposed price, which we must take into account
    let bundleCost = offer.price.value - utility;

    let markupRatio = utility / bundleCost;

    if (markupRatio > 1.8 || (myLastPrice != null && Math.abs(offer.price - myLastPrice) < minDicker)) { // If our markup is large, accept the offer
      bid.type = 'Accept';
      bid.price = offer.price;
    }
    else if (markupRatio < -0.5) { // If buyer's offer is substantially below our cost, reject their offer
      bid.type = 'Reject';
      bid.price = null;
    }
    else { // If buyer's offer is in a range where an agreement seems possible, generate a counteroffer
      bid.type = 'SellOffer';
      bid.price = generateSellPrice(bundleCost, offer.price, myLastPrice, timeRemaining);
      if(bid.price.value < offer.price.value + minDicker) {
        bid.type = 'Accept';
        bid.price = offer.price;
      }
    }
  }
  else { // The buyer didn't include a proposed price, leaving us free to consider how much to charge.
    // Set markup between 2 and 3 times the cost of the bundle and generate price accordingly.
    let markupRatio = 1.8 + Math.random();
    let bundleCost = -1.0 * utility; // Utility is -1 * bundle cost since price is interpreted as 0
    bid.type = 'SellOffer';
    bid.price = {
      unit: utilityInfo.currencyUnit,
      value: quantize(markupRatio * bundleCost, 2)
    };
  }
  logExpression("About to return from generateBid with bid: ", 2);
  logExpression(bid, 2);
  return bid;
}


// *** generateSellPrice()
// Generate a bid price that is sensitive to cost, negotiation history with this buyer, and time remaining in round

function generateSellPrice(bundleCost, offerPrice, myLastPrice, timeRemaining) {
  logExpression("Entered generateSellPrice.", 2);
  logExpression("bundleCost: " + bundleCost, 2);
  logExpression("offerPrice: ", 2);
  logExpression(offerPrice, 2);
  logExpression("myLastPrice: " + myLastPrice, 2);
  logExpression("timeRemaining: " + timeRemaining, 2);
  let minMarkupRatio;
  let maxMarkupRatio;
  let markupRatio = offerPrice.value/bundleCost - 1.0;
  if(myLastPrice != null) {
    maxMarkupRatio = myLastPrice/bundleCost - 1.0;
  }
  else {
    maxMarkupRatio = 1.8 - 1.3 * (1.0 - timeRemaining/negotiationState.roundDuration); // Linearly decrease max markup ratio towards just 0.5 at the conclusion of the round
  }
  minMarkupRatio = Math.max(markupRatio, 0.15);

  logExpression("Min and max markup ratios are: " + minMarkupRatio + " and " + maxMarkupRatio + ".", 2);

  let minProposedMarkup = Math.max(minMarkupRatio, markupRatio);
  let newMarkupRatio = minProposedMarkup + (Math.random() * (maxMarkupRatio - minProposedMarkup)) / 1.2;

  logExpression("newMarkupRatio: " + newMarkupRatio, 2);

  let price = {
    unit: offerPrice.unit,
    value: (1.0 + newMarkupRatio) * bundleCost
  };
  price.value = quantize(price.value, 2);

  logExpression("Returning price: ", 2);
  logExpression(price, 2);
  return price;
}


// *** processMessage()
// Orchestrate a sequence of
// * classifying the message to obtain and intent and entities
// * interpreting the intents and entities into a structured representation of the message
// * determining (through self-policing) whether rules permit a response to the message
// * generating a bid (or other negotiation act) in response to the offer

function processMessage(message) {
  logExpression("In processMessage, message is: ", 2);
  logExpression(message, 2);
  return classifyMessage(message)
  .then(classification => {
    classification.environmentUUID = message.environmentUUID;
    logExpression("Classification from classify message: ", 2);
    logExpression(classification, 2);
    return interpretMessage(classification);
  })
  .then(interpretation => {
    logExpression("interpretation is: ", 2);
    logExpression(interpretation, 2);
    let speaker = interpretation.metadata.speaker;
    let addressee = interpretation.metadata.addressee;
    let message_speaker_role = interpretation.metadata.role;
    if(speaker == agentName) { // The message was from me; this means that the system allowed it to go through.
      logExpression("This message is from me! I'm not going to talk to myself.", 2);
      // If the message from me was an accept or reject, wipe out the bidHistory with this particular negotiation partner
      // Otherwise, add the message to the bid history with this negotiation partner
      if (interpretation.type == 'AcceptOffer' || interpretation.type == 'RejectOffer') {
          bidHistory[addressee] = null;
      }
      else {
        if(bidHistory[addressee]) {
          bidHistory[addressee].push(interpretation);
        }
      }
    }
    else if (message_speaker_role == "buyer") { // Message is from a buyer
      logExpression("Interpretation of message: ", 2);
      logExpression(interpretation, 2);
      let messageResponse = { // Start forming message, in case I want to send it
        text: "",
        speaker: agentName,
        role: "seller",
        addressee: speaker,
        environmentUUID: interpretation.metadata.environmentUUID,
        timeStamp: new Date()
      };
      if(addressee == agentName && interpretation.type == "AcceptOffer") { // Buyer accepted my offer! Deal with it.
        logExpression("The buyer " + speaker + " accepted my offer.", 2);
        logExpression(bidHistory, 2);
        if(bidHistory[speaker] && bidHistory[speaker].length) { // I actually did make an offer to this buyer; fetch details and confirm acceptance
          let bidHistoryIndividual = bidHistory[speaker].filter(bid =>
            {return (bid.metadata.speaker == agentName && bid.type == "SellOffer");}
          );
          if (bidHistoryIndividual.length) {
            logExpression(bidHistoryIndividual, 2);
            let acceptedBid = bidHistoryIndividual[bidHistoryIndividual.length - 1];
            logExpression(acceptedBid, 2);
            bid = {
              price: acceptedBid.price,
              quantity: acceptedBid.quantity,
              type: "Accept"
            };
            logExpression(bid, 2);
            messageResponse.text = translateBid(bid, true);
            messageResponse.bid = bid;
            bidHistory[speaker] = null;
          }
          else { // Didn't have any outstanding offers with this buyer
            messageResponse.text = "I'm sorry, but I'm not aware of any outstanding offers.";
          }
        }
        else { // Didn't have any outstanding offers with this buyer
          messageResponse.text = "I'm sorry, but I'm not aware of any outstanding offers.";
        }
        return messageResponse;
      }
      else if (addressee == agentName && interpretation.type == "RejectOffer") { // The buyer claims to be rejecting an offer I made; deal with it
        logExpression("My offer was rejected!", 2);
        logExpression(bidHistory, 2);
        if(bidHistory[speaker] && bidHistory[speaker].length) { // Check whether I made an offer to this buyer
          let bidHistoryIndividual = bidHistory[speaker].filter(bid =>
            {return (bid.metadata.speaker == agentName && bid.type == "SellOffer");}
          );
          if (bidHistoryIndividual.length) {
            messageResponse.text = "I'm sorry you rejected my bid. I hope we can do business in the near future.";
            bidHistory[speaker] = null;
          }
          else {
            messageResponse.text = "There must be some confusion; I'm not aware of any outstanding offers.";
          }
        }
        else {
          messageResponse.text = "OK, but I didn't think we had any outstanding offers.";
        }
        return messageResponse;
      }
      else if (addressee == agentName && interpretation.type == "Information") { // The buyer is just sending me an informational message. Reply politely without attempting to understand.
        logExpression("This is an informational message.", 2);
        let messageResponse = {
          text: "OK. Thanks for letting me know.",
          speaker: agentName,
          role: "seller",
          addressee: speaker,
          environmentUUID: interpretation.metadata.environmentUUID,
          timeStamp: new Date()
        };
        return messageResponse;
      }
      else if (addressee == agentName && interpretation.type == "NotUnderstood") { // The buyer said something, but we can't figure out what they meant. Just ignore them and hope they'll try again if it's important.
        logExpression("I didn't understand this message; pretend it never happened.", 2);
        return Promise.resolve(null);
      }
      else if(interpretation.type == "BuyOffer" ||
               interpretation.type == "BuyRequest") { // The buyer is making an offer or a request
        if(mayIRespond(message_speaker_role, addressee)) { // I'm going to let myself respond, as dictated by mayIRespond()

          if(!bidHistory[speaker]) bidHistory[speaker] = [];
          bidHistory[speaker].push(interpretation);

          let bid = generateBid(interpretation); // Generate bid based on message interpretation, utility, and the current state of negotiation with the buyer
          logExpression("Proposed bid is: ", 2);
          logExpression(bid, 2);

          let bidResponse = {
            text: translateBid(bid, false), // Translate the bid into English
            speaker: agentName,
            role: "seller",
            addressee: speaker,
            environmentUUID: interpretation.metadata.environmentUUID,
            timeStamp: new Date()
          };
          bidResponse.bid = bid;

          return bidResponse;
        }
        else { // Message was from a buyer, but I'm voluntarily opting not to respond, as dictated by mayIRespond()
          logExpression("I'm choosing not to do respond to this buy offer or request.", 2);
          logExpression(message, 2);
          return Promise.resolve(null);
        }
      }
      else { // None of the specific cases are satisfied; don't take any action
        return Promise.resolve(null);
      }
    }
    else if(message_speaker_role == "seller") { // Message was from another seller. A more clever agent might be able to exploit this info somehow!
      logExpression("The other seller, " + speaker + ", sent this message: ", 2);
      logExpression(message, 2);
      return Promise.resolve(null);
    }
  })
  .catch(error => {
    logExpression("Encountered error in processMessage: ", 1);
    logExpression(error, 1);
    return Promise.resolve(null);
  });
}


// ******************************************************************************************************* //
//                                                     Simple Utilities                                    //
// ******************************************************************************************************* //

// *** quantize()
// Quantize numeric quantity to desired number of decimal digits
// Useful for making sure that bid prices don't get more fine-grained than cents
function quantize(quantity, decimals) {
  let multiplicator = Math.pow(10, decimals);
  let q = parseFloat((quantity * multiplicator).toFixed(11));
  return Math.round(q) / multiplicator;
}


// *** getSafe()
// Utility that retrieves a specified piece of a JSON structure safely.
// o: the JSON structure from which a piece needs to be extracted, e.g. bundle
// p: list specifying the desired part of the JSON structure, e.g.['price', 'value'] to retrieve bundle.price.value
// d: default value, in case the desired part does not exist.

function getSafe(p, o, d) {
  return p.reduce((xs, x) => (xs && xs[x] != null && xs[x] != undefined) ? xs[x] : d, o);
}


// ******************************************************************************************************* //
//                                                    Messaging                                            //
// ******************************************************************************************************* //


// *** translateBid()
// Translate structured bid to text, with some randomization

function translateBid(bid, confirm) {
  let text = "";
  let count = 0;
  let and = "";
  if(bid.type == 'SellOffer') {
    text = "Ok, how about if I sell you";
    Object.keys(bid.quantity).forEach(good => {
      if(count > 0){
        and = "and ";
      }
      if(good == "egg") {
        text += " " + and + bid.quantity[good] + " " + good + "(s)";
      }
      else if(good == "milk" || good == "flour" || good == "sugar") {
        text += " " + and + bid.quantity[good] + " cup(s) of " + good;
      }
      else if(good == "chocolate") {
        text += " " + and + bid.quantity[good] + " ounce(s) of " + good;
      }
      else if(good == "vanilla") {
        text += " " + and + bid.quantity[good] + " teaspoon(s) of " + good;
      }
      else if(good == "blueberry") {
        text += " " + and + bid.quantity[good] + " packs(s) of " + good;
      }
      else{
        text += " " + bid.quantity[good] + " " + good;
      }
      count = count + 1;
    });
    text += " for " + bid.price.value + " " + bid.price.unit + ".";
  }
  else if(bid.type == 'Reject') {
    text = selectMessage(rejectionMessages);
  }
  else if(bid.type == 'Accept') {
    if(confirm) {
      text = selectMessage(confirmAcceptanceMessages);
    }
    else {
      text = selectMessage(acceptanceMessages);
    }
    Object.keys(bid.quantity).forEach(good => {
      if(count > 0){
        and = "and ";
      }
      if(good == "egg") {
        text += " " + and + bid.quantity[good] + " " + good + "(s)";
      }
      else if(good == "milk" || good == "flour" || good == "sugar") {
        text += " " + and + bid.quantity[good] + " cup(s) of " + good;
      }
      else if(good == "chocolate") {
        text += " " + and + bid.quantity[good] + " ounce(s) of " + good;
      }
      else if(good == "vanilla") {
        text += " " + and + bid.quantity[good] + " teaspoon(s) of " + good;
      }
      else if(good == "blueberry") {
        text += " " + and + bid.quantity[good] + " packs(s) of " + good;
      }
      else{
        text += " " + bid.quantity[good] + " " + good;
      }
      count = count + 1;
    });
    text += " for " + bid.price.value + " " + bid.price.unit + ".";
  }
  return text;
}


// *** selectMessage()
// Randomly select a message or phrase from a specified set

function selectMessage(messageSet) {
  let msgSetSize = messageSet.length;
  let indx = parseInt(Math.random() * msgSetSize);
  return messageSet[indx];
}


// *** sendMessage()
// Send specified message to the /receiveMessage route of the environment orchestrator

function sendMessage(message) {
  message.roundId = roundId;
  logExpression("Sending message to environment orchestrator: ", 2);
  logExpression(message, 2);
  return postDataToServiceType(message, 'environment-orchestrator', '/relayMessage');
}


// *** postDataToServiceType()
// POST a given json to a service type; mappings to host:port are externalized in the appSettings.json file

function postDataToServiceType(json, serviceType, path) {
  let serviceMap = appSettings.serviceMap;
  if(serviceMap[serviceType]) {
    let options = serviceMap[serviceType];
    options.path = path;
    let url = options2URL(options);
    let rOptions = {
      method: 'POST',
      uri: url,
      body: json,
      json: true
    };
    return request(rOptions)
    .then(response => {
      return response;
    })
    .catch(error => {
      logExpression("Error: ", 1);
      logExpression(error, 1);
      return null;
    });
  }
}


// *** options2URL()
// Convert host, port, path to URL

function options2URL(options) {
  let protocol = options.protocol || 'http';
  let url = protocol + '://' + options.host;
  if (options.port) url += ':' + options.port;
  if (options.path) url  += options.path;
  return url;
}
