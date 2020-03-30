global.XMLHttpRequest = require("xmlhttprequest").XMLHttpRequest;
global.btoa = str => Buffer.from(str, 'binary').toString('base64');

const OsmRequest = require("osm-request");
const db = require('./db');
const i18n = require('./locales.json')[process.env.OSM_LANG || "fr"];

const delay = parseInt(process.env.DELAY_OSM) || 300000;

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

				const text = `${i18n.note.header}

${i18n.note.name} : ${note.name || i18n.note.unknown}
${i18n.note.url} : ${process.env.OSM_API_URL}/${note.osmid}

${i18n.note.status} : ${i18n.status[note.status]}
${note.details ? (i18n.note.details + " : " + note.details + "\n") : ""}
${note.opening_hours ? ("opening_hours:covid19=" + note.opening_hours) : ""}
${note.tags ? (Object.entries(note.tags).map(e => e.join("=")).join("\n")+"\n") : ""}
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
// 					console.log("No notes has been created");
					afterAll();
				}
			});
		}
		else {
// 			console.log("No notes to send to OSM");
			afterAll();
		}
	})
	.catch(e => {
		console.error(e);
		afterAll();
	});
}

// Automatic check for sending updates
function sendDataToOSM() {
	const afterAll = () => {
		setTimeout(sendDataToOSM, delay);
	};

	db.getContributionsForUpload()
	.then(async contribs => {
		if(contribs.length > 0) {
			// Create changeset
			const changesetId = await osmApi.createChangeset(i18n.changeset.editor, i18n.changeset.comment);

			if(changesetId) {
				// Go through all edited features
				const editedElemIds = [];
				for(let contrib of contribs) {
					let elem = await osmApi.fetchElement(contrib.osmid);

					if(elem) {
						// Define tags
						const tags = contrib.tags ? contrib.tags : {};

						if(contrib.details && contrib.details.trim().length > 0) {
							tags["description:covid19"] = contrib.details.trim();
						}

						if(contrib.status === "open") {
							tags["opening_hours:covid19"] = contrib.opening_hours || "open";
						}
						else if(contrib.status === "closed") {
							tags["opening_hours:covid19"] = "off";
						}

						// Send to API
						elem = osmApi.setTags(elem, tags);
						elem = osmApi.setTimestampToNow(elem);
						const result = await osmApi.sendElement(elem, changesetId);

						if(result) {
							editedElemIds.push(contrib.id);
						}
						else {
							console.error("Failed to update OSM element", contrib.osmid);
						}
					}
				}

				osmApi.closeChangeset(changesetId);

				// Send back edited features into DB
				if(editedElemIds.length > 0) {
					db.setContributionsSent(editedElemIds)
					.then(() => {
						console.log(`Updated ${editedElemIds.length} elements on OSM`);
						afterAll();
					})
					.catch(e => {
						console.error(e);
						afterAll();
					});
				}
				else {
// 					console.log("Nothing has been edited");
					afterAll();
				}
			}
			else {
				console.error("Can't create changeset");
				afterAll();
			}
		}
		else {
// 			console.log("Nothing to send to OSM");
			afterAll();
		}
	})
	.catch(e => {
		console.error(e);
		afterAll();
	});
}

function start() {
	console.log("OSM data sending process started");
	sendDataToOSM();
	setTimeout(() => sendNotesToOSM(), delay / 2);
};

// Start process
start();
