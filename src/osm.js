global.XMLHttpRequest = require("xmlhttprequest").XMLHttpRequest;
global.btoa = str => Buffer.from(str, 'binary').toString('base64');

const OsmRequest = require("osm-request");
const db = require('./db');

const languageFallback = process.env.OSM_LANG || "fr";
const delay = parseInt(process.env.DELAY_OSM) || 300000;
let delayedContributionsSent = [];

function getBestI18nAvailable(language) {
	try {
		return require(`../locales/${language}.json`);
	} catch (e) {
		return require(`../locales/${languageFallback}.json`);
	}
}

// Create OSM Request
const osmApi = new OsmRequest({
	endpoint: process.env.OSM_API_URL,
	oauthConsumerKey: process.env.OSM_API_KEY,
	oauthSecret: process.env.OSM_API_SECRET,
	basicauth: { user: process.env.OSM_USER, pass: process.env.OSM_PASS }
});

// Automatic check for notes
function sendNotesToOSM() {
	const afterAll = () => {
		setTimeout(sendNotesToOSM, delay);
	};

	db.getContributionsForNotes()
	.then(notes => {
		if(notes.length > 0) {
			const sentNotesIds = [];

			const processNext = () => {
				if(notes.length === 0) { return Promise.resolve(); }

				const note = notes.pop();

				const i18n = getBestI18nAvailable(note.language);

				const text = `${i18n.note.header.replace(/{HASHTAG_COUNTRY}/g, note.country ? "#cartomobilite"+note.country : "").trim()}

${i18n.note.name} ${note.name || i18n.note.unknown}
${note.osmid !== 'new' ? i18n.note.url+" "+process.env.OSM_API_URL+"/"+note.osmid+"\n" : ""}
${note.details ? (i18n.note.details + " " + note.details + "\n") : ""}
${note.tags ? (Object.entries(note.tags).filter(e => e[1] && e[1] !== "null").map(e => e.join("=")).join("\n")+"\n") : ""}
${i18n.note.footer}`;

				return osmApi.createNote(note.lat, note.lon, text)
				.then(() => {
					sentNotesIds.push(note.id);
					return processNext();
				})
				.catch(e => {
					console.error(e);
					return processNext();
				});
			}

			processNext()
			.then(() => {
				// Send back edited features into DB
				if(sentNotesIds.length > 0) {
					db.setContributionsSent(sentNotesIds)
					.then(() => {
						console.log(`Created ${sentNotesIds.length} notes on OSM`);
						afterAll();
					})
					.catch(e => {
						console.error(e);
						afterAll();
					});
				}
				else {
					afterAll();
				}
			});
		}
		else {
			afterAll();
		}
	})
	.catch(e => {
		console.error(e);
		afterAll();
	});
}

function isEquivalent(a, b) {
	// Create arrays of property names
	var aProps = Object.getOwnPropertyNames(a);
	var bProps = Object.getOwnPropertyNames(b);

	// If number of properties is different,
	// objects are not equivalent
	if (aProps.length != bProps.length) {
		return false;
	}

	for (var i = 0; i < aProps.length; i++) {
		var propName = aProps[i];

		// If values of same property are not equal,
		// objects are not equivalent
		if (a[propName] !== b[propName]) {
			return false;
		}
	}

	// If we made it this far, objects
	// are considered equivalent
	return true;
}

/**
 * Handles a single changeset (used for cluster separating)
 */
function prepareSendChangeset(contribs) {
	return new Promise(async resolve => {
		const i18n = getBestI18nAvailable("en");
		let changesetId;

		// Go through all edited features
		const editedElemIds = [];
		for(let contrib of contribs) {
			try {
				let elem = await osmApi.fetchElement(contrib.osmid);

				if(elem) {
					// Define tags
					const elemStartTags = osmApi.getTags(elem);
					const tags = contrib.tags ? contrib.tags : {};

					// Tags for removal
					Object.entries(tags).forEach(e => {
						const [k,v] = e;
						if(v === "null") {
							elem = osmApi.removeTag(elem, k);
							delete tags[k];
						}
					});

					elem = osmApi.setTags(elem, tags);
					const elemEndTags = osmApi.getTags(elem);

					if(Object.keys(tags).length > 0 && !isEquivalent(elemStartTags, elemEndTags)) {
						elem = osmApi.setTimestampToNow(elem);

						// Create changeset if not existing
						if(!changesetId) {
							const changesetTags = {};
							if(i18n.changeset.description) { changesetTags.description = i18n.changeset.description; }
							changesetId = await osmApi.createChangeset(i18n.changeset.editor, i18n.changeset.comment, changesetTags);
						}

						// Send to API if changeset was created
						if(changesetId) {
							const result = await osmApi.sendElement(elem, changesetId);

							if(result) {
								editedElemIds.push(contrib.id);
							}
							else {
								console.error("Failed to update OSM element", contrib.osmid);
							}
						}
						else {
							console.error("Can't create changeset");
							resolve();
						}
					}
					// No changes in tags = skip update
					else {
						editedElemIds.push(contrib.id);
					}
				}
			}
			catch(e) {
				// Check error code from OSM API
				try {
					const errorJson = JSON.parse(e.message);

					// If element doesn't exist or has been deleted, marked as edited
					if([404, 410].includes(errorJson.status)) {
						editedElemIds.push(contrib.id);
					}
				}
				catch(e2) {
					console.error("Error with", contrib.osmid, ":", e);
				}
			}
		}

		if(changesetId) {
			osmApi.closeChangeset(changesetId);
		}

		// Send back edited features into DB
		if(editedElemIds.length > 0) {
			db.setContributionsSent(editedElemIds)
			.then(() => {
				console.log(`Updated ${editedElemIds.length} elements on OSM`);
				resolve();
			})
			.catch(e => {
				delayedContributionsSent = delayedContributionsSent.concat(editedElemIds);
				console.error(e);
				resolve();
			});
		}
		else {
			resolve();
		}
	});
}

// Automatic check for sending updates
function sendDataToOSM() {
	const afterAll = () => {
		setTimeout(sendDataToOSM, delay);
	};

	if(delayedContributionsSent.length > 0) {
		db.setContributionsSent(delayedContributionsSent)
		.then(() => {
			console.log("Delayed data sent to DB");
			delayedContributionsSent = [];
			sendDataToOSM();
		})
		.catch(e => {
			console.error("Can't send data to DB", e);
			afterAll();
		});
	}
	else {
		db.getContributionsForUpload()
		.then(async contribs => {
			if(contribs.length > 0) {
				console.log("Will send", contribs.length, "changesets");
				const handleNext = () => {
					if(contribs.length > 0) {
						prepareSendChangeset(contribs.pop())
						.then(() => handleNext());
					}
					else {
						afterAll();
					}
				};
				handleNext();
			}
			else {
				afterAll();
			}
		})
		.catch(e => {
			console.error(e);
			afterAll();
		});
	}
}

function start() {
	console.log("OSM data sending process started");
	sendDataToOSM();
	setTimeout(() => sendNotesToOSM(), Math.min(delay / 2, 30000));
};

// Start process
start();
