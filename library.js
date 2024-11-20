(function(module) {
"use strict";

require('./lib/nodebb.js');

var Telegram = {};

var db = require.main.require('./src/database'),
	meta = require.main.require('./src/meta'),
	user = require.main.require('./src/user'),
	posts = require.main.require('./src/posts'),
	Topics = require.main.require('./src/topics'),
	Categories = require.main.require('./src/categories'),
	messaging = require.main.require('./src/messaging'),
	SocketPlugins = require.main.require('./src/socket.io/plugins'),
	winston = require.main.require('winston'),
	nconf = require.main.require('nconf'),
	async = require.main.require('async'),
	S = require.main.require('string'),
	cache = require('lru-cache'),
	lang_cache,
	translator = require.main.require('./src/translator'),
	moment = require('./lib/moment.min.js'),
	pubsub = require.main.require('./src/pubsub'),
	privileges = require.main.require('./src/privileges'),

	Settings = require('./lib/userSettings.js')(Telegram),
 //   SocketAdmins = require.main.require('./socket.io/admin');

    TelegramBot = require('node-telegram-bot-api');

var bot = null;
var token = null;
var message = null;
var messageQueue = {};
var plugin = {
		config: {
			telegramid: '',
               chatid:'',
               roomId:'',
			maxLength: '',
			postCategories: '',
			topicsOnly: '',
			messageContent: ''
		}
    };

const errorHandler = (err) => {
    winston.error(`[plugins/telegram] ${err.message}`);
    if (process.env.NODE_ENV === 'development') {
        winston.error(err.stack);
    }
};

const validateSettings = (settings) => {
    const defaults = {
        telegramid: '',
        chatid: '',
        roomId: '',
        maxLength: '1024',
        postCategories: '[]',
        topicsOnly: 'off',
        messageContent: 'New post in forum:'
    };

    return Object.assign({}, defaults, settings);
};

const formatMessage = (content, data = {}) => {
    const maxLength = parseInt(plugin.config.maxLength, 10) || 1024;
    let message = content;

    if (message.length > maxLength) {
        message = message.substring(0, maxLength - 3) + '...';
    }

    // Replace placeholders
    Object.entries(data).forEach(([key, value]) => {
        message = message.replace(new RegExp(`{${key}}`, 'g'), value);
    });

    return message;
};

const retry = async (fn, retries = 3, delay = 1000) => {
    try {
        return await fn();
    } catch (err) {
        if (retries === 0) throw err;
        await new Promise(resolve => setTimeout(resolve, delay));
        return retry(fn, retries - 1, delay * 2);
    }
};

Telegram.init = async function(params) {
	const { router, middleware } = params;
	
	// Prepare templates
	const controllers = {
		getTelegramBotAdmin: function(req, res) {
			res.render('admin/plugins/telegrambot', {});
		},
		getTelegramBotSettings: function(req, res) {
			pubsub.on('telegram:me', function(me){
				res.render('user/settings', {botname:me.username});
			});
			pubsub.publish('telegram:getMe');
		}
	};

	// Create routes
	router.get('/admin/telegrambot', middleware.admin.buildHeader, controllers.getTelegramBotAdmin);
	router.get('/api/admin/telegrambot', controllers.getTelegramBotAdmin);
	router.get('/telegram/settings', Telegram.isLoggedIn, middleware.buildHeader, controllers.getTelegramBotSettings);
	router.get('/api/telegram/settings', Telegram.isLoggedIn, controllers.getTelegramBotSettings);

	// User language cache
	const numUsers = await db.getObjectField('global', 'userCount');
	const cacheOpts = {
		max: numUsers > 0 ? Math.floor(numUsers / 20) : 50,
		maxAge: 1000 * 60 * 60 * 24
	};
	lang_cache = cache(cacheOpts);

	// Get settings
	const settings = await meta.settings.get('telegram-notification');
	plugin.config = validateSettings(settings);
	token = plugin.config['telegramid'];

	if(nconf.get('isPrimary') && !nconf.get('jobsDisabled') && token) {
		console.log("trying to start Telegram Bot");
		startBot();
		if (bot) {
			console.log("Telegram Bot started\n");
		}
	}

	// 添加狀態檢查路由
	router.get('/api/admin/plugins/telegram/status', middleware.admin.checkPrivileges, async (req, res) => {
		try {
			const status = await Telegram.getStatus();
			res.json(status);
		} catch (err) {
			res.status(500).json({error: err.message});
		}
	});
};

function startBot()
{
	// Prepare bot
		
		messageQueue = {};
        	console.log("\n\n\nToken; "+token+"\n\n\n");

        
		// Setup polling way
		 bot = global.telegram = new TelegramBot(token,{polling: true});

		bot.on('text', function (msg) {
			var chatId = msg.chat.id;
			var userId = msg.from.id;
			var username = msg.from.username;
			var text = msg.text;
            if (plugin.config['chatid'] == '')
            {
                plugin.config['chatid'] = chatId;
            }
            
			if(!message)
			{
				message = "\n Hello this is the ForumBot\n\n"+
                          "I am your interface to your "+
                          "NodeBB Forum\n\n"+
                          "Your Telegram ID: {userid}\n"+
                          "ID of this chat:<b> "+msg.chat.id+ "</b>\n"+
                          "Open a chat with me and type /bothelp to see, what I can do for you\n"+
                          "You even may enter commands here: like '/<command> <parameters>@forumbot', "+
                          "but I always ill answer in private chat only";
			}
			if (text.toLowerCase().indexOf("@forumbot") >=3)
            { 
               var text2 = text.split("@forumbot"); //remove the @forumbot, that should be at the end of the command
               text = text2.join(" "); //recover the command
            
	    }
  	    else
            {   
           //     if (msg.text == "@ForumBot")
                if (text.toLowerCase() == "@forumbot")
                {
                    var messageToSend = message.replace("{userid}", msg.from.id);
                    bot.sendMessage(msg.chat.id, messageToSend);
                }
		else
		    {
	    		if(text.indexOf("/") == 0)
			{	
				parseCommands(userId, text);
			}
		    }
            }
			
	});

		// Notification observer.
		pubsub.on('telegram:notification', function(data){
			bot.sendMessage(data.telegramId, data.message).catch(function(){});
		});

		// Settings observer.
		pubsub.on('telegram:getMe', function(){
			bot.getMe().then(function(me){
				pubsub.publish('telegram:me', me);
			}).catch(function(){});
		});        

		bot.on('error', (error) => {
			errorHandler(error);
		});

		bot.on('polling_error', (error) => {
			winston.error(`[plugins/telegram] Polling error: ${error.message}`);
			setTimeout(() => {
				if (bot) {
					bot.stopPolling().then(() => {
						startBot();
					});
				}
			}, 10000);
		});
}   // function startbot


var parseCommands = async function(telegramId, mesg) {
    function respond(response) {
        pubsub.publish('telegram:notification', {telegramId: telegramId, message: response});
    }

    async function respondWithTranslation(uid, response) {
        const lang = await Telegram.getUserLanguage(uid);
        const translated = await translator.translate(response, lang);
        respond(translated);
    }

    if(mesg.indexOf("/") == 0) {
        try {
            const uid = await db.sortedSetScore('telegramid:uid', telegramId);
            if(!uid) {
                return respond("UserID not found.. Put your TelegramID again in the telegram settings of the forum. :(");
            }

            const command = mesg.split(" "); // Split command
            
            if(command[0].toLowerCase() == "/reply" && command.length >= 2) {
                // Reply to topic
                const data = {
                    uid: uid,
                    tid: command[1],
                    content: command.slice(2).join(" ")
                };

                if(messageQueue[data.uid]) {
                    return await respondWithTranslation(uid, "[[error:too-many-messages]]");
                }

                messageQueue[data.uid] = true;
                try {
                    await Topics.reply(data);
                    await respondWithTranslation(uid, "[[success:topic-post]]");
                } catch(err) {
                    await respondWithTranslation(uid, err.message);
                } finally {
                    delete messageQueue[data.uid];
                }
            }
            else if(command[0].toLowerCase() == "/recent") {
                const numtopics = Math.min(30, command[1] || 10);
                try {
                    const result = await Topics.getSortedTopics({
                        uid: uid,
                        start: 0,
                        stop: Math.max(1, numtopics) - 1,
                        term: 'alltime'
                    });

                    let response = "";
                    for(const topic of result.topics) {
                        const title = topic.title;
                        const tid = topic.tid;
                        const username = topic.user.username;
                        const time = moment.unix(topic.lastposttime / 1000).fromNow();
                        const url = nconf.get("url") + "/topic/" + tid;
                        response += `${title} ${time} by ${username}\n${url}\n\n`;
                    }
                    respond(response);
                } catch(err) {
                    respond("[[error:no-recent-topics]]");
                }
            }
            // ... 其他命令保持不變 ...
        } catch(err) {
            winston.error(`[plugins/telegram] Error in parseCommands: ${err.message}`);
            respond("An error occurred while processing your command");
        }
    }
};

	
Telegram.postSave = async function(postData) {
    const post = postData.post;
    const roomId = -plugin.config['roomId'];
    const topicsOnly = plugin.config['topicsOnly'] || 'off';
    
    if (topicsOnly === 'off' || (topicsOnly === 'on' && post.isMain)) {
        try {
            const [userData, topicData, categoryData] = await Promise.all([
                user.getUserFields(post.uid, ['username', 'picture']),
                Topics.getTopicFields(post.tid, ['title', 'slug']),
                Categories.getCategoryFields(post.cid, ['name', 'bgColor'])
            ]);

            const categories = JSON.parse(plugin.config['postCategories'] || '[]');
            if (!categories || categories.indexOf(String(post.cid)) >= 0) {
                let content = post.content;
                const maxQuoteLength = plugin.config['maxLength'] || 1024;
                
                if (content.length > maxQuoteLength) {
                    content = content.substring(0, maxQuoteLength) + '...';
                }

                const messageContent = `${plugin.config['messageContent']}\n${content}\n\n${nconf.get('url')}/topic/${topicData.slug}/`;

                if (bot) {
                    await bot.sendMessage(roomId, messageContent);
                } else {
                    winston.verbose("Telegram: No bot found");
                }
            }
        } catch(err) {
            winston.error(`[plugins/telegram] Error in postSave: ${err.message}`);
        }
    }
};

Telegram.getUserLanguage = async function(uid) {
    if (lang_cache && lang_cache.has(uid)) {
        return lang_cache.get(uid);
    }
    
    const settings = await user.getSettings(uid);
    const language = settings.language || meta.config.defaultLang || 'en_GB';
    lang_cache.set(uid, language);
    return language;
};

/* changed notification mechanism
 * Users need to join the configured Telegram room now in order to be notified,
 * as there may be non- forum members on telegram.
 * the method below can be enabled again to provide additional notifications to 
 * forum users with configured telegram ID
 */
Telegram.pushNotification = async function(data) {
    const notifObj = data.notification;
    const uids = data.uids;
    
    winston.verbose('[plugins/telegram] Push notification:', notifObj);

    if (!Array.isArray(uids) || !uids.length || !notifObj) {
        return;
    }

    if(notifObj.nid && notifObj.nid.indexOf("post_flag") > -1) {
        // Disable notifications from flags.
        return;
    }

    try {
        // Get users data
        const usersData = await user.getUsersFields(uids, ["telegramid"]);
        
        // Process each user
        for(const userData of usersData) {
            const telegramId = userData.telegramid;
            const uid = userData.uid;
            
            try {
                // Get user language
                const lang = await Telegram.getUserLanguage(uid);
                
                // Prepare notification
                notifObj.bodyLong = notifObj.bodyLong || '';
                notifObj.bodyLong = S(notifObj.bodyLong).unescapeHTML().stripTags().unescapeHTML().s;
                
                // Get notification data
                const [title, postIndex, topicSlug] = await Promise.all([
                    translator.translate(notifObj.bodyShort, lang).then(translated => 
                        S(translated).stripTags().s
                    ),
                    posts.getPidIndex(notifObj.pid, notifObj.tid, ''),
                    Topics.getTopicFieldByPid('slug', notifObj.pid)
                ]);

                // Prepare and send notification
                const url = nconf.get('url') + notifObj.path;
                const body = `${title}\n\n${notifObj.bodyLong}\n\n${url}`;

                winston.verbose('[plugins/telegram] Sending notification to uid ' + uid);
                pubsub.publish('telegram:notification', {telegramId: telegramId, message: body});
            } catch(err) {
                winston.error(`[plugins/telegram] Error processing notification for uid ${uid}: ${err.message}`);
            }
        }
    } catch(err) {
        winston.error(`[plugins/telegram] Error in pushNotification: ${err.message}`);
    }
};
/**/



Telegram.addNavigation = async function(custom_header) {
    custom_header.plugins.push({
        route: '/telegrambot',
        icon: 'fa-telegram',  // 添加 Font Awesome 圖標
        name: 'Telegram Notifications'
    });

    return custom_header;
};


Telegram.isLoggedIn = function(req, res, next) {
    if (!req.user || !req.user.uid || parseInt(req.user.uid, 10) <= 0) {
        return res.status(403).render('403', {
            title: '[[global:403.title]]',
            message: '[[global:403.message]]'
        });
    }
    next();
};

Telegram.getStatus = async function() {
    return {
        initialized: !!bot,
        connected: bot ? bot.isPolling() : false,
        config: {
            ...plugin.config,
            telegramid: plugin.config.telegramid ? '***' : '' // 隱藏 token
        }
    };
};

module.exports = Telegram;

}(module));
