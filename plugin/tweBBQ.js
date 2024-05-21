import puppeteer from "puppeteer";
import {MongoClient as mongodb} from "mongodb";
import axios from "axios";
import path from "path";
import fs from "fs-extra";
import marshmallow from "./marshmallow";
import twitter from "./twitter";
import {Waithere} from "waithere"

const DB_PORT = 27017;
const DB_PATH = "mongodb://127.0.0.1:" + DB_PORT;
const TWEMOJI_REG = new RegExp("\p{Extended_Pictographic}", "gu");
const TWEMOJI_GROUP_REG = new RegExp(`(${TWEMOJI})+`, "g");

const config = global.config.bbq;
const defaultTemplate = config.defaultTemplate;
const STORAGEPATH = config.storagePath;
const queue = new Waithere(2);

let connection = true;


const BBQ_ARGS = {
    "原推" : "origin",
    "翻译" : "origin",
    "连续翻译" : "serialTrans",
    "回复" : "reply",
    "颜色" : "color",
    "大小" : "size",
    "字体" : "font_family",
    "装饰" : "text_decoration",
    "css" : "css",
    "替换" : "replace",
    "插图" : "image",
    "棉花糖" : "marshmallow",
    "汉化组" : "group_info",
    "汉化组大小" : "group_size",
    "汉化组颜色" : "group_color",
    "汉化组字体" : "group_font_family",
    "汉化组装饰" : "group_text_decoration",
    "汉化组css" : "group_css",
    "回复中logo" : "in_reply_logo",
    "回复中logo大小" : "in_reply_logo_size",
    "背景" : "background",
    "引用" : "quote",
    "选项" : "choice",
    "覆盖" : "cover_origin",
    "无汉化组" : "no_logo",
    "回复中覆盖" : "cover_origin_in_reply",
    "回复中无汉化组" : "no_logo_in_reply",
    "group_html" : "group_html",
    "article_html" : "article_html",
}

if (!fs.existsSync(STORAGEPATH)) fs.mkdir(STORAGEPATH);

let replyFunc = (context, msg, at = false) => {};

function cookTweReply(replyMsg) {
    replyFunc = replyMsg;
}

/** 检查网络情况，如果连不上Twitter那后面都不用做了*/
function checkConnection() {
    return axios.get("https://twitter.com", {
        headers : {
            "User-Agent" : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36"
        }
    }).then(res => {connection = (res.status == 200) ? true : false})
    .catch(err => {
        console.error("Twitter checkConnection error with", err.response.status, err.response.statusText);
        return false;
    });
}

/**
 * Twitter截图
 * @param {object} context
 * @param {string} twitter_url 单条Tweet网址
 * @param {object} trans_args 所有翻译相关选项
 */
async function cook(context, twitter_url, trans_args={}) {
    try {
        let tweet_id = /status\/(\d+)/.exec(twitter_url)[1];
        if (/[^\w\/\.:]/.test(twitter_url)) {
            replyFunc(context, `${twitter_url}\n这个链接错误了`);
            return;
        }
        replyFunc(context, "收到，如果2分钟后还没有图可能是瘫痪了");
        let conversation = await rebuildConversation(tweet_id);
        if (!conversation) {
            throw 1;
        }

        let html_ready = {};
        if (trans_args && Object.keys(trans_args).length > 0) {
            trans_args = fillTemplate(trans_args);
            trans_args = ensureStructure(trans_args, conversation);
            html_ready = await fillHtml(trans_args, conversation);
        }

        let browser = await puppeteer.launch({
            args : ['--no-sandbox', '--disable-dev-shm-usage']
        });
        let page = await browser.newPage();
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.72 Safari/537.36");
        await page.setExtraHTTPHeaders({
            "sec-ch-ua" : '" Not A;Brand";v="99", "Chromium";v="90", "Google Chrome";v="90"',
            "accept-language" : "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7,ja;q=0.6",
            "DNT" : "1"
        });
        await page.setBypassCSP(true);
        await page.emulateTimezone('Asia/Tokyo');
        await page.goto(twitter_url, {waitUntil : "networkidle0"});

        await page.click('.r-tm2x56 [role=button]').catch(err => {});

        let init_size = await page.evaluate(() => {
            let buttom = document.querySelector('article .css-1dbjc4n .r-1r5su4o');
            buttom.scrollIntoView();
            let top = document.querySelector('body');
            top.scrollIntoView();
            let {x, y, height, width} = buttom.getBoundingClientRect();

            return {x, y, height, width}
        });
        await page.setViewport({
            width : 800,
            height : Math.round(init_size.y) + 500,
            deviceScaleFactor: 1.6
        });
        await page.waitForTimeout(500);

        if (trans_args && Object.keys(trans_args).length > 0) {
            await page.evaluate((html_ready, trans_args, conversation) => {
                let banner = document.getElementsByTagName('header')[0];
                if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
                let header = document.querySelector('main').firstChild.firstChild.firstChild.firstChild.firstChild.firstChild;
                if (header && header.parentNode) header.parentNode.removeChild(header);
                let footer = document.getElementsByClassName('css-1dbjc4n r-aqfbo4 r-1p0dtai r-1d2f490 r-12vffkv r-1xcajam r-zchlnj')[0];
                if (footer && footer.parentNode) footer.parentNode.removeChild(footer);
                let fullScrrenNotice = document.querySelector('.r-ifefl9');
                if (fullScrrenNotice && fullScrrenNotice.parentNode) fullScrrenNotice.parentNode.removeChild(fullScrrenNotice);

                let articles = document.querySelectorAll('article');
                let article = articles[0].querySelector('[role=group]').parentElement;
                insert(article, html_ready.trans_article_html,
                    html_ready.reply_html != undefined ? ((trans_args.no_logo_in_reply) ? '' : html_ready.logo_in_reply)
                        : html_ready.trans_group_html
                    , html_ready.reply_html != undefined ? trans_args.cover_origin_in_reply : trans_args.cover_origin);

                if (trans_args.article.image != undefined) {
                    trans_args.article.image = "data:image/jpeg;base64," + trans_args.article.image;

                    let card_img = document.querySelector('img[src*=card_img]');
                    let image = document.querySelector('img[alt="图像"][src^="https://pbs.twimg"]');
                    if (card_img != null) {
                        card_img.parentElement.firstChild.style.backgroundImage = `url(${trans_args.article.image})`
                        card_img.src = trans_args.article.image;
                    }
                    else if (image != null) {
                        image.parentElement.firstChild.style.backgroundImage = `url(${trans_args.article.image})`
                        image.src = trans_args.article.image;
                    }
                    else {
                        let img_outer = document.createElement("div");
                        img_outer.className = "css-1dbjc4n r-9x6qib r-1867qdf r-1phboty r-rs99b7 r-156q2ks r-1ny4l3l r-1udh08x r-o7ynqc r-6416eg";
                        img_outer.style = "border-color: rgb(204, 214, 221); border-radius: 16px;"

                        let img_inner = document.createElement("div");
                        img_inner.className = "css-1dbjc4n r-1niwhzg r-vvn4in r-u6sd8q r-4gszlv r-1p0dtai r-1pi2tsx r-1d2f490 r-u8s1d r-zchlnj r-ipm5af r-13qz1uu r-1wyyakw"
                        img_inner.style.backgroundImage = `url(${trans_args.article.image})`;

                        let newImg = document.createElement("img");
                        newImg.src = trans_args.article.image;
                        newImg.className = "css-9pa8cd";

                        let img_padding = document.createElement("div");
                        img_padding.className = "r-1adg3ll r-13qz1uu";

                        let img_wrapper = document.createElement("div");

                        img_outer.appendChild(img_padding);
                        img_outer.appendChild(img_wrapper);
                        img_wrapper.appendChild(img_inner);
                        img_wrapper.appendChild(newImg);

                        newImg.onload = () => {
                            img_padding.style.paddingBottom = `${(100 * newImg.height/newImg.width).toPrecision(4)}%`;
                            article.insertBefore(img_outer, article.firstElementChild.nextSibling);
                        }
                    }
                }

                let video = document.querySelector('[data-testid="videoPlayer"]');
                if (video) {
                    let poster = false;
                    if (video.querySelector('[poster]') != null) poster = video.querySelector('[poster]').poster;
                    else poster = conversation.poster;
                    if (poster) {
                        video.firstChild.lastChild.style = "width: 100%; height: 100%; background-color: transparent; overflow: hidden;";
                        video.firstChild.lastChild.innerHTML = `<video style="background-color: black; height:100%; width:100%; max-height:100%; max-width:100%" poster="${poster}"></video>`;
                    }
                }

                if (trans_args.article.quote != undefined) {
                    let quote_block = document.querySelector('.r-1bs4hfb');
                    if (!quote_block) quote_block = document.querySelector('.css-1dbjc4n .css-1dbjc4n .css-1dbjc4n.r-1s2bzr4 .css-1dbjc4n [role]');
                    quote_block.firstChild.children[1].querySelector("[lang]").innerHTML = html_ready.quote_html;
                }

                if (trans_args.article.choice != undefined) {
                    let choice_list = document.querySelectorAll('section [role="button"][tabindex="0"].r-gafmid');
                    for (let i = 0; i < trans_args.article.choice.length; i++) {
                        choice_list[i].firstChild.innerText = trans_args.article.choice[i];
                    }
                }

                if (html_ready.reply_html != undefined && html_ready.reply_html.length > 0) {
                    for (let i = 0; i < html_ready.reply_html.length; i++) {
                        if (i + 1 >= articles.length) break;
                        else if (!html_ready.reply_html[i]) continue;
                        else {
                            article = articles[i+1].querySelector('[role=group]').parentElement;

                            insert(article, html_ready.reply_html[i],
                                i+1 === html_ready.reply_html.length ? (trans_args.no_logo ? '' : html_ready.trans_group_html) :
                                (trans_args.no_logo_in_reply ? '' : html_ready.logo_in_reply),
                                i+1 === html_ready.reply_html.length ? trans_args.cover_origin : trans_args.cover_origin_in_reply);
                        }
                    }
                }
                function insert(article, translation_html, group_html, cover_origin=false) {
                    let trans_place = document.createElement('div');
                    let node_group_info = document.createElement('div');
                    let node_trans_article = document.createElement('div');

                    trans_place.lang = "zh";
                    node_group_info.innerHTML = group_html;
                    node_trans_article.innerHTML = translation_html;

                    let text_node = false;
                    if (/^回复 \n@/.test(article.firstChild.innerText)) text_node = article.children[1].firstChild;
                    else text_node = article.firstChild.firstChild;
                    if (!text_node) return;

                    node_trans_article.className = text_node.firstChild.className;
                    node_trans_article.style.width = "100%";

                    trans_place.appendChild(node_group_info);
                    trans_place.appendChild(node_trans_article);

                    if (cover_origin) text_node.firstChild.replaceWith(trans_place);
                    else text_node.appendChild(trans_place);
                }
                document.querySelector("#react-root").scrollIntoView(true);
            }, html_ready, trans_args, conversation);
        }
        else {
            await page.evaluate((conversation) => {
                let banner = document.getElementsByTagName('header')[0];
                if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
                let header = document.querySelector('main').firstChild.firstChild.firstChild.firstChild.firstChild.firstChild;
                if (header && header.parentNode) header.parentNode.removeChild(header);
                let footer = document.getElementsByClassName('css-1dbjc4n r-aqfbo4 r-1p0dtai r-1d2f490 r-12vffkv r-1xcajam r-zchlnj')[0];
                if (footer && footer.parentNode) footer.parentNode.removeChild(footer);
                let fullScrrenNotice = document.querySelector('.r-ifefl9');
                if (fullScrrenNotice && fullScrrenNotice.parentNode) fullScrrenNotice.parentNode.removeChild(fullScrrenNotice);

                let video = document.querySelector('[data-testid="videoPlayer"]');
                if (video) {
                    let poster = false;
                    if (video.querySelector('[poster]') != null) poster = video.querySelector('[poster]').poster;
                    else poster = conversation.poster;
                    if (poster) {
                        video.firstChild.lastChild.style = "width: 100%; height: 100%; background-color: transparent; overflow: hidden;";
                        video.firstChild.lastChild.innerHTML = `<video style="background-color: black; height:100%; width:100%; max-height:100%; max-width:100%" poster="${poster}"></video>`;
                    }
                }
                document.querySelector("#react-root").scrollIntoView(true);
            }, conversation);
        }

        await page.waitForTimeout(500);
        let tweet_box = await page.$('article .css-1dbjc4n .r-1r5su4o').then(buttom => {
            return buttom.boundingBox();
        });

        let img_path = path.join(STORAGEPATH, `${tweet_id}.jpg`);
        await page.screenshot({
            type : "jpeg",
            quality : 100,
            path : img_path,
            clip : {x : 2, y : 0, width : tweet_box.width + 25, height : tweet_box.y + tweet_box.height + 8}
        }).then(() => {
            replyFunc(context, `[CQ:image,file=file:///${img_path}]`);
        });

        await browser.close();
    } catch(err) {
        if (err == 1) {
            replyFunc(context, `没有${twitter_url} 这条Twitter\n可能是被删了`, true);
        }
        else {
            console.error(err);
            replyFunc(context, "出错惹", true);
        }
    }
}

async function serialTweet(context, twitter_url, trans_args={}) {
    let tweet = await getTweet(/status\/(\d+)/.exec(twitter_url)[1]);

    if ("in_reply_to_status_id" in tweet && tweet.in_reply_to_user_id != null) {
        replyFunc(context, "这个功能不能烤回复推！", true);
        return;
    }
    let browser = await puppeteer.launch({
        args : ["--no-sandbox", "--disable-dev-shm-usage"], ignoreDefaultArgs : ["--enable-automation"]
    });
    let page = await browser.newPage();
    await page.setBypassCSP(true);
    await page.setExtraHTTPHeaders({
        "user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.3987.163 Safari/537.36",
        "accept-language" : "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7,ja;q=0.6",
        "DNT" : "1"
    });
    await page.emulateTimezone('Asia/Tokyo');
    let {groups : {username, tweet_id}} = /https:\/\/twitter\.com\/(?<username>.+?)\/status\/(?<tweet_id>\d+)/i.exec(twitter_url);
    await page.goto(`https://twitter.com/search?q=(from:${username}) -filter:replies&f=live`, {waitUntil : "networkidle0"});

    try {
        await page.waitForSelector(`[href$="${tweet_id}"]`, {visible : true, timeout : 10000});
    } catch(err) {
        replyFunc(context, "大失败！可能是：\n链接错误或者太过远古或者连接超时", true);
        await browser.close();
        return;
    };

    try {
        let html_ready = await setupHTML(trans_args);
        await page.evaluate((html_ready, trans_args, tweet_id) => {
            let header = document.getElementsByClassName("css-1dbjc4n r-aqfbo4 r-14lw9ot r-my5ep6 r-rull8r r-qklmqi r-gtdqiz r-ipm5af r-1g40b8q")[0];
            header.parentNode.removeChild(header);
            let footer = document.getElementsByClassName('css-1dbjc4n r-aqfbo4 r-1p0dtai r-1d2f490 r-12vffkv r-1xcajam r-zchlnj')[0];
            footer.parentNode.removeChild(footer);

            let articles = document.querySelectorAll('article');
            let focus = 0;

            for (let i = 0; i < articles.length; i++) {
                let article = articles[i];
                if (article.querySelector(`[href$="${tweet_id}"]`) != null) {
                    article.scrollIntoView(true);
                    focus = i;
                    break;
                }
                else article.parentElement.removeChild(article);
            }

            for (let i = 0; i < html_ready.serialTrans.length; i++) {
                insert(articles[focus + i].querySelector('[role=group]').parentElement, html_ready.serialTrans[i],
                    html_ready.no_group_info ? "" : html_ready.trans_group_html, trans_args.cover_origin);
            }

            function insert(article, translation_html, group_html, cover_origin=false) {
                let trans_place = document.createElement('div');
                let node_group_info = document.createElement('div');
                let node_trans_article = document.createElement('div');

                trans_place.lang = "zh";
                node_group_info.innerHTML = group_html;
                node_trans_article.innerHTML = translation_html;

                if (/^回复 \n@/.test(article.firstElementChild.innerText)) article = article.children[1].firstElementChild;
                else article = article.firstElementChild.firstElementChild;
                if (article == null) return;

                trans_place.appendChild(node_group_info);
                trans_place.appendChild(node_trans_article);

                if (cover_origin) article.replaceWith(trans_place);
                else article.appendChild(trans_place);
            }
        }, html_ready, trans_args, tweet_id);

        await page.waitForTimeout(2000);
        let box = await page.evaluate((html_ready) => {
            document.querySelector("#react-root").scrollIntoView(true);
            let articles = document.querySelectorAll('article');
            let box = {};
            box.first = articles[0].getBoundingClientRect();
            box.last = articles[html_ready.serialTrans.length - 1].getBoundingClientRect();
            return JSON.stringify(box);
        }, html_ready)
        box = JSON.parse(box);

        await page.setViewport({
            width: 800,
            height: Math.round(box.last.bottom + 200),
            deviceScaleFactor: 1.8
        });

        await page.screenshot({
            type : "jpeg",
            quality : 100,
            encoding : "base64",
            clip : {x : box.first.x, y : 3, width : box.first.width - 7, height : box.last.bottom - 4},
        }).then(pic64 => replyFunc(context, `[CQ:image,file=base64://${pic64}]`));

    } catch(err) {
        console.error(err);
        replyFunc(context, "出错惹", true);
        await browser.close();
        return;
    }

    await browser.close();
}

function ensureStructure(trans_args, conversation) {
    if (conversation.quote && trans_args.article.reply && trans_args.article.reply.length > 0
        && trans_args.article.reply.length === conversation.reply.length + 1) {
            let a_reply = trans_args.article.reply;
            trans_args.article.quote = a_reply[a_reply.length - 1];
            trans_args.article.reply = a_reply.slice(0, a_reply.length - 1);
    }
    if ("reply" in trans_args.article && trans_args.article.reply.length > conversation.reply.length) {
        throw "args中的回复数量比可用的多";
    }
    if ("reply" in trans_args.article && trans_args.article.reply.length < 1) {
        delete trans_args.article.reply;
    }

    return trans_args;
}

async function fillHtml(trans_args, conversation) {
    let html_ready = await setupHTML(trans_args, conversation);

    if (trans_args.cover_origin != undefined && trans_args.cover_origin_in_reply == undefined) {
        trans_args.cover_origin_in_reply = trans_args.cover_origin;
    }
    if (trans_args.no_logo != undefined && trans_args.no_logo_in_reply == undefined) {
        trans_args.no_logo_in_reply = trans_args.no_logo;
    }
    if (trans_args.article.retweet != undefined) {
        trans_args.article.retweet = `<div class="css-901oao">${decoration(trans_args.article.retweet, trans_args.article)}</div>`;
    }
    if (trans_args.article.image != undefined && trans_args.article.image) {
        trans_args.article.image = await axios.get(trans_args.article.image, {responseType:'arraybuffer'})
            .then(res => {return Buffer.from(res.data, 'binary').toString('base64')}).catch(err => {throw "获取图片错误"});
    }
    if (trans_args.article.marshmallow != undefined && trans_args.article.marshmallow) {
        trans_args.article.image = await marshmallow.toast({}, trans_args.article.marshmallow.replace(/<br>/g, "\n"), false);
    }

    if ("reply" in trans_args.article && trans_args.article.reply.length > 0) {
        let logo_in_reply = Object.create(trans_args.group);
        logo_in_reply.size = trans_args.in_reply.logo_size;
        html_ready.logo_in_reply =
            `<div style="margin: 1px 0px 2px 1px; display: inline-block;">${decoration(trans_args.in_reply.logo, logo_in_reply)}</div>`;
    }

    return html_ready;
}

function getTweet(tweet_id) {
    return axios({
        method:'GET',
        url: "https://api.twitter.com/1.1/statuses/lookup.json",
        headers : {"authorization" : "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"},
        params : {
            "id" : tweet_id,
            "include_entities" : "true",
            "include_ext_alt_text" : "true",
            "include_card_uri" : "true",
            "tweet_mode" : "extended",
            "trim_user" : "true"
        }
    }).then(res => {return res.data[0];}).catch(err => {
        console.error(err.response.status, err.response.statusText);
        return false;
    });
}

function getConversation(tweet_id) {
    let headers = twitter.httpHeader();
    return axios({
        method : "GET",
        url : `https://twitter.com/i/api/2/timeline/conversation/${tweet_id}.json`,
        headers : headers,
        params : {
            "simple_quoted_tweet": true,
            "tweet_mode" : "extended",
            "trim_user": true,
        }
    }).then(res => {return res.data
    }).catch(err => {
        console.error("getConversation error", tweet_id, err.response);
        return false;
    })
}

async function rebuildConversation(tweet_id) {
    let conversation = {
        origin : "",
        quote : "",
        reply : [],
        poster : ""
    };

    let tweet = await getTweet(tweet_id);
    if (tweet == undefined || !tweet) return false;

    conversation.origin = tweetTextPrepare(tweet);
    if (tweet.in_reply_to_status_id_str == undefined && tweet.quoted_status_id_str == undefined) {
        mediaPoster(conversation, tweet);
        return conversation;
    }

    let timeline = (await getConversation(tweet_id)).globalObjects.tweets || false;
    if (!timeline) return conversation;

    let begin = true;
    while(1) {
        if (!begin) conversation.reply.push(tweetTextPrepare(tweet));
        else begin = false;
        mediaPoster(conversation, tweet);
        if ("is_quote_status" in tweet && tweet.is_quote_status == true && tweet.quoted_status_id_str != undefined) {
            conversation.quote = tweetTextPrepare(timeline[tweet.quoted_status_id_str]);
            mediaPoster(conversation, timeline[tweet.quoted_status_id_str]);
        }
        if ("in_reply_to_status_id_str" in tweet && tweet.in_reply_to_status_id_str != null) {
            tweet = timeline[tweet.in_reply_to_status_id_str];
        }
        else break;
    }

    if (conversation.reply.length > 0) {
        let temp = conversation.origin;
        conversation.origin = conversation.reply[conversation.reply.length - 1];
        conversation.reply.pop();
        conversation.reply.reverse();
        conversation.reply.push(temp);
    }
    return conversation;

    function mediaPoster(conversation, tweet) {
        if ("extended_entities" in tweet && "media" in tweet.extended_entities) {
            let media = tweet.extended_entities.media;
            for (let m of media) {
                if (m.type == "animated_gif" || m.type == "video") {
                    conversation.poster = m.media_url_https;
                }
            }
        }
        return conversation;
    }
}


function tweetTextPrepare(tweet) {
    let text = tweet.full_text;
    if ("urls" in tweet.entities && tweet.entities.urls.length > 0) {
        for (let i = 0; i < tweet.entities.urls.length; i++) {
            text = tweet.full_text.replace(tweet.entities.urls[i].url, tweet.entities.urls[i].expanded_url);
        }
    }
    return text;
}

function convProcess(trans_args, conversation) {
    if ("extra" in trans_args && trans_args.extra.replace) {
        for (let key in conversation) {
            let value = conversation[key];
            if (value.length == 0) continue;
            if (Array.isArray(value)) {
                for (let i = 0; i < value.length; i++) {
                    conversation[key][i] = textAlter(trans_args.extra.replace, value[i]);
                }
            }
            else conversation[key] = textAlter(trans_args.extra.replace, value);
        }
    }
    return conversation;
}

async function setupHTML(trans_args, conversation) {
    conversation = convProcess(trans_args, conversation);

    let html_ready = {}
    if (trans_args.article.origin != undefined) {
        html_ready.trans_article_html = trans_args.article_html == undefined ?
            decoration(trans_args.article.origin, trans_args.article, conversation.origin || false) : trans_args.article_html;
        // html_ready.trans_article_html = `<div class="css-901oao r-hkyrab r-1tl8opc r-1blvdjr r-16dba41 r-ad9z0x r-bcqeeo r-bnwqim r-qvutc0">${html_ready.trans_article_html}</div>`
        html_ready.trans_article_html = `<div style="display: block; overflow-wrap: break-word;">${html_ready.trans_article_html}</div>`
    }

    if ("serialTrans" in trans_args.article && trans_args.article.serialTrans.length > 0) {
        html_ready.serialTrans = [];
        for (let trans of trans_args.article.serialTrans) {
            html_ready.serialTrans.push(['<div style="display: block; white-space: pre-wrap; overflow-wrap: break-word;">',`${decoration(trans, trans_args.article)}</div>`].join(""));
        }
    }
    if (trans_args.article.quote != undefined) {
        html_ready.quote_html =
            `<div lang="zh" style="display: block; white-space: pre-wrap; overflow-wrap: break-word;">${decoration(trans_args.article.quote, trans_args.article, conversation.quote || false)}</div>`;
    }
    if (trans_args.article.reply != undefined) {
        html_ready.reply_html = [];
        for (let i in trans_args.article.reply) {
            if (trans_args.article.reply[i].length == 0) continue;
            html_ready.reply_html.push(
            `<div style="display: block; white-space: pre-wrap; overflow-wrap: break-word;">${decoration(trans_args.article.reply[i], trans_args.article, conversation.reply[i] || false)}</div>`);
        }
    }
    if (!trans_args.no_logo) {
        if (/^http/.test(trans_args.group.group_info)) {
            trans_args.group.size = trans_args.group.size == defaultTemplate.group.size ? '30px' : trans_args.group.size;
            let img64 = "data:image/jpeg;base64," + await axios.get(trans_args.group.group_info, {responseType:'arraybuffer'})
                                                                .then(res => {return Buffer.from(res.data, 'binary').toString('base64')});
            html_ready.trans_group_html = `<img style="margin: 4px 0px -3px 1px; height: auto; width: auto; max-height: ${trans_args.group.size}; max-width: 100%;" src="${img64}">`;
        }
        else {
            html_ready.trans_group_html = (trans_args.group_html == undefined) ?
                ['<div dir="auto" class="css-901oao r-hkyrab r-1tl8opc r-1blvdjr r-16dba41 r-ad9z0x r-bcqeeo r-bnwqim r-qvutc0"',
                ' style="display: block; margin: 4px 0px 3px 1px;">',
                decoration(trans_args.group.group_info, trans_args.group), '</div>'].join("")
                : ['<div dir="auto" class="css-901oao r-hkyrab r-1tl8opc r-1blvdjr r-16dba41 r-ad9z0x r-bcqeeo r-bnwqim r-qvutc0;" ',
                    'style="margin: 4px 0px 4px 1px; display: block;">',
                     trans_args.group_html, '</div>'].join("");
        }
    }
    else html_ready.trans_group_html = "";
    return html_ready;
}

function decoration(text, template, origin_text = "") {
    let css = ('css' in template && template.css.length > 1) ? template.css
        : template ? `font-family: ${template.font_family}; font-size: ${template.size};
        text-decoration: ${template.text_decoration}; color: ${template.color}; background: ${template.background};`
        : "all: inherit;";

    let ready_html =
        `<div class="css-901oao css-1dbjc4n" style="display: block; white-space: pre-wrap; overflow-wrap: break-word; ${css}">${parseString(text, origin_text)}</div>`;

    return ready_html;
}

function parseString(text, origin_text = false) {
    text = text.replace(/&#91;/g, "[").replace(/&#93;/g, "]");
    if (/\/e/.test(text) && origin_text != false) {
        let ori = origin_text.match(TWEMOJI_GROUP_REG);
        let replacement = text.match(/\/e/g);

        if (ori != null && replacement != null) {
            for (let i = 0; i < replacement.length; i++) {
                if (i > ori.length -1) break;
                text = text.replace(/\/e/, ori[i]);
            }
        }
    }

    if (/^[^\/]\/[\u4E00-\u9FCB]/.test(text)) {
        let pattern = [text.substring(0, 3)];
        text = text.substring(3, text.length);
        origin_text = textAlter(pattern, origin_text);
    }

    if (/\/z/.test(text) && origin_text != false) {
        let ori = [...origin_text.matchAll(/([\u4E00-\u9FCB])\1{3,}/g)];
        let replacement = [...text.matchAll(/\/z/g)];

        if (ori != null && replacement != null) {
            for (let i = 0; i < replacement.length; i++) {
                if (i > ori.length -1) break;
                text = text.replace(/\/z/, ori[i][0]);
            }
        }
    }

    if (/\/c/.test(text) && origin_text != false) {
        let ori = origin_text
            .match(/([^\w\n０-９\u23e9-\u23ec\u23f0\u23f3\u267e\u26ce\u2705\u2728\u274c\u274e\u2753-\u2755\u2795-\u2797\u27b0\u27bf\u2800-\u2B55\udf00-\udfff\udc00-\ude4f\ude80-\udeff\u3040-\u30FF\u4E00-\u9FCB\u3400-\u4DB5\uac00-\ud7ff]|[03_・ー゛゜灬◦]){4,}|([_・ー゛゜◦])\2{3,}/g);
        let replacement = text.match(/\/c/g);

        if (ori != null && replacement != null) {
            for (let i = 0; i < replacement.length; i++) {
                if (i > ori.length -1) break;

                let last_one = ori[i].length - 1;
                let last_code = ori[i].charCodeAt(last_one);
                if (last_code > 0xd800 && last_code < 0xdfff) {
                    ori[i] = ori[i].substring(0, last_one);
                }
                text = text.replace(/\/c/, ori[i]);
            }
        }
    }

    if (/[\s\/](\W{1,5})[x×*]([0-9]{1,2})/.test(text)) {
        let repeat = [...text.matchAll(/[\s\/](.{1,5})[x×*](\d{1,2})/g)];
        for (let rpt of repeat) {
            text = text.replace(rpt[0], new Array(parseInt(rpt[2])+1).join(rpt[1]));
        }
    }

    if (/\/u/.test(text) && origin_text != false) {
        let ori = [...origin_text.matchAll(/([--:\w?@%&+~#=]*\.[a-z]{2,4}\/{0,2})((?:[?&](?:\w+)=(?:\w+))+|[--:\w?@%&+~#=]+)?/g)];
        let replacement = text.match(/\/u/g);
        if (ori != null && replacement != null) {
            for (let i in replacement) {
                if (i > ori.length -1) break;
                ori[i][0] = ori[i][0].replace(/https?:\/\//, "");
                text = text.replace(/\/u/, ori[i][0]);
            }
        }
    }

    text = text.replace(/((#|@)\S+?)(?=([】\])\s@]|<br>|$))/g,'<span style="color:#1DA1F2;">$1</span>')
        .replace(/(([--:\w?@%&+~#=]*\.[a-z]{2,4}\/{0,2})((?:[?&](?:\w+)=(?:\w+))+|[--:\w?@%&+~#=]+)?)/g,'<span style="color:#1DA1F2;">$1</span>');

    let capture = [...text.matchAll(TWEMOJI_REG)];
    let ready_html = "";
    let string_html = "";
    let emoji_html = "";
    if (capture[0] != undefined) {
        let offset = 0;
        let code = "";
        let part = "";
        for (let emoji of capture) {
            code = grabTheRightIcon(emoji[0]);
            part = text.substring(offset, emoji.index);
            string_html = (part.length > 0) ? crtString(part) : "";
            emoji_html =
                [`<span dir="auto" class="css-901oao css-16my406 r-4qtqp9 r-ip8ujx r-sjv1od r-zw8f10 r-bnwqim r-h9hxbl">`,
                `<div aria-label="${emoji[0]}" class="css-1dbjc4n r-xoduu5 r-1mlwlqe r-1d2f490 r-1udh08x r-u8s1d r-h9hxbl r-417010" style="height: 1.2em;">`,
                '<div class="css-1dbjc4n r-1niwhzg r-vvn4in r-u6sd8q r-x3cy2q r-1p0dtai r-xoduu5 r-1pi2tsx r-1d2f490 r-u8s1d r-zchlnj r-ipm5af r-13qz1uu r-1wyyakw"',
                `style="background-image: url(&quot;https://abs-0.twimg.com/emoji/v2/svg/${code}.svg&quot;);"></div>`,
                `<img alt="${emoji[0]}" draggable="false" src="https://abs-0.twimg.com/emoji/v2/svg/${code}.svg" class="css-9pa8cd"></div></span>`].join("");

                ready_html += (offset > emoji.index) ? emoji_html + string_html : string_html + emoji_html;
                offset = emoji.index + emoji[0].length;
        }
        if (offset < text.length) ready_html += crtString(text.substr(offset, text.length-1));
    }
    else {
        ready_html = crtString(text);
    }
    return ready_html;

    function crtString(text_part) {
        return `<span style="overflow-wrap: break-word;">${text_part}</span>`;
    }
}

function grabTheRightIcon(rawText) {
    const U200D = String.fromCharCode(8205);
    return toCodePoint(rawText.indexOf(U200D) < 0 ? rawText.replace(/\uFE0F/g, "") : rawText)
}

function toCodePoint(unicodeSurrogates, sep) {
    var r = [],
        c = 0,
        p = 0,
        i = 0;
    while (i < unicodeSurrogates.length) {
        c = unicodeSurrogates.charCodeAt(i++);
        if (p) {
            r.push((65536 + (p - 55296 << 10) + (c - 56320)).toString(16));
            p = 0
        } else if (55296 <= c && c <= 56319) {
            p = c
        } else {
            r.push(c.toString(16));
        }
    }
    return r.join(sep || "-");
}

function textAlter(patterns, text) {
    for (let pat of patterns) {
        let alt = pat.split("/");
        let pattern = [`(${alt[0]})`, "\\1{3,}"].join("");
        let replacement = text.match(new RegExp(pattern, "g"));

        for (let rpt of replacement) {
            let replaced = rpt.replace(new RegExp(`${alt[0]}`, "g"), alt[1]);
            text = text.replace(rpt, replaced);
        }
    }
    return text;
}

function setTemplate(unparsed) {
    const ARGS = Object.keys(BBQ_ARGS).join("|");
    let trans_args = {article : {}, group : {}, in_reply : {},extra : {}};
    let err = false;

    const ARGS_SPT = new RegExp(`[+＋](?=${ARGS})`, "i");
    const ARGS_REG = new RegExp(`(?<=${ARGS})[=＝]`, "i");

    const STYLE_OPTIONS = unparsed.split(ARGS_SPT);
    for (let i in STYLE_OPTIONS) {
        let option = STYLE_OPTIONS[i].split(ARGS_REG).filter((noEmpty) => {return noEmpty != undefined});
        let style = BBQ_ARGS[option[0].trim().replace(/<br>/g, "")] || false;
        let arg = option.slice(1).join("");

        if (!style) {
            let sentences = unparsed.split(/<br>[+＋]/);
            trans_args.article.origin = sentences[0];

            if (sentences.length > 1) {
                for (let i = 1; i < sentences.length; i++) {
                    if (!Array.isArray(trans_args.article.reply)) trans_args.article.reply = [];
                    if (/\[CQ:image/.test(sentences[i])) trans_args.article.image = /(http.+?)\?/.exec(sentences[i])[1];
                    else trans_args.article.reply.push(sentences[i]);
                }
            }
        }
        else if (/iframe/.test(arg)) err = "你想干什么？";
        else if (style == "article_html" || style == "group_html") trans_args[style] = arg.trim();
        else {
            if (style == "origin" || style == "reply" || style == "group_info");
            else if (arg) arg.trim().replace(/<br>/g, "");

            if (/^group_/.test(style) && !/\[CQ:image/.test(arg)) trans_args.group[style.replace(/^group_(?!info)/, "")] = arg;
            else if (/^in_reply_/.test(style)) trans_args.in_reply[style.replace(/^in_reply_/, "")] = arg;
            else if (style == 'cover_origin') trans_args.cover_origin = true;
            else if (style == 'no_logo') trans_args.no_logo = true;
            else if (style == 'cover_origin_in_reply') trans_args.cover_origin_in_reply = true;
            else if (style == 'no_logo_in_reply') trans_args.no_logo_in_reply = true;
            else if (style == 'group_info' && /\[CQ:image/.test(arg)) trans_args.group.group_info = /(http.+?)\?/.exec(option.join(""))[1];
            else if (style == 'choice') {
                trans_args.article.choice = arg.split(/[;；]/).filter((noEmpty) => {return noEmpty != undefined && noEmpty.length > 0});
            }
            else if (style == 'reply') {
                if (!Array.isArray(trans_args.article.reply)) trans_args.article.reply = [arg];
                else trans_args.article.reply.push(arg);
            }
            else if (style == "serialTrans") {
                trans_args.article.serialTrans = arg.split(/[;；]/, 10);
            }
            else if (style == "image" && /\[CQ:image/.test(arg)) {
                trans_args.article.image = /(http.+?)\?/.exec(option.join(""))[1];
            }
            else if (style == "replace" && /.\/[\u4E00-\u9FCB]/.test(arg)) {
                trans_args.extra.replace = arg.split(/[,，]/).filter((noEmpty) => {return noEmpty != undefined && noEmpty.length > 0});
            }
            else {
                if (/\[CQ:image/.test(arg)) err = `在${option[0]}这个位置不能插图`;
                trans_args.article[style] = arg;
            }
        }
    }

    return {trans_args : trans_args, err : err};
}

function fillTemplate(template = {}) {
    return [defaultTemplate, template].reduce((prev, next) => {
        for (let key in prev) {
            if (typeof(prev[key]) == "object") {
                next[key] = {...prev[key], ...next[key]};
            }
            else next[key] = next[key] != undefined ? next[key] : prev[key];
        }
        return next;
    });
}

function saveTemplate(context, username, unparsed_text) {
    let {trans_args, err} = setTemplate(unparsed_text);

    if (err) {
        replyFunc(context, err, true);
        return;
    };
    if ('origin' in trans_args.article || 'reply' in trans_args.article || "retweet" in trans_args.article || "choice" in trans_args.article) {
        replyFunc(context, '不能将翻译内容加入模板', true);
        return;
    }

    mongodb(DB_PATH, {useUnifiedTopology: true}).connect().then(async mongo => {
        let coll = mongo.db('bot').collection('twiBBQ');
        try {
            await coll.updateOne({username : username},
                {$set : {trans_args, group_id : context.group_id}}, {upsert : true});
            replyFunc(context, `成功保存了${username}的模板`);
        } catch(err) {
            console.error(err);
            replyFunc(context, "出错惹");
        } finally {mongo.close();}
    });
}

function findTemplate(username, group_id) {
    return mongodb(DB_PATH, {useUnifiedTopology: true}).connect().then(async mongo => {
        let coll = mongo.db('bot').collection('twiBBQ');
        try {
            let res = await coll.findOne({group_id : group_id, username : username})
                || await coll.findOne({group_id : group_id});
            return (res &&"trans_args" in res) ? res.trans_args : false;
        } catch(err) {console.error(err);
        } finally {mongo.close();}
    });
}

function storeRecentTranslation(group_id, twitter_url, tweet_id, id, trans_args) {
    mongodb(DB_PATH, {useUnifiedTopology: true}).connect().then(async mongo => {
        let text = trans_args.article.origin;
        if (text.length > 14) text = text.substring(0, 14);
        text = text.replace(/<br>/g, " ");

        let coll = mongo.db('bot').collection('twe_sum');
        try {
            let res = await coll.findOne({"group_id" : group_id, "done.tweet_id" : tweet_id});
            if (res) {
                await coll.updateOne({"group_id" : group_id, "done.tweet_id" : tweet_id}, {
                    $set : {"done.$.twitter_url" : twitter_url, "done.$.id" : id,
                    "done.$.trans_args" : trans_args, "done.$.text" : text}},
                    {upsert : true});
            }
            else {
                await coll.updateOne({"group_id" : group_id},
                    {$push : {done : {$each : [{tweet_id, id, trans_args, text, twitter_url}],
                    $slice : -10, $sort : {"tweet_id" : 1}}}});
            }

            await coll.updateOne({"group_id" : group_id},
                    {$pull : {rare : {"tweet_id" : tweet_id}}});
        } catch(err) {console.error(err);
        } finally {mongo.close();}
    });
}

function bbqRisidue(context) {
    mongodb(DB_PATH, {useUnifiedTopology: true}).connect().then(async mongo => {
        let coll = mongo.db('bot').collection('twe_sum');
        try {
            let res = await coll.findOne({"group_id" : context.group_id}, {projection : {list : 0}});
            mongo.close();
            let summary = [];

            if (res && "rare" in res && res.rare.length > 0) {
                let recent_rare = ["米"];
                for (let rare of res.rare) {
                    let line = [rare.id || rare.twitter_url, rare.text].join(" ".repeat(3));
                    recent_rare.push(line);
                }
                summary.push(recent_rare.join("\n"));
            }
            else {
                summary.push("没米了");
            }

            if (res && "done" in res && res.done.length > 0) {
                let recent_done = ["锅巴"];

                for (let done of res.done) {
                    let line = [done.id || done.twitter_url, done.text].join(" ".repeat(3));
                    recent_done.push(line);
                }

                summary.push(recent_done.join("\n"));
            }
            else {
                replyFunc(context, "此处空无一物");
            }

            replyFunc(context, summary.join("\n".repeat(2)))
        } catch(err) {console.error(err);}
    });
}

function formatTranslated(trans_args) {
    const article = trans_args.article;
    let text = [article.origin];
    if ("quote" in article && article.quote.length > 0) text.push("引用了", article.quote);
    if ("reply" in article && article.reply.length > 0) {
        for (let reply of article.reply) {
            if (reply.length > 0) text.push("回复了", reply);
        }
    }
    return text.join("\n").replace(/<br>/g, "\n");
}

function retriveUrl(group_id, id) {
    return new Promise((resolve, reject) => {
        try {
            mongodb(DB_PATH, {useUnifiedTopology: true}).connect().then(async mongo => {
                const twe_sum = mongo.db('bot').collection('twe_sum');
                const res = await twe_sum.findOne({group_id : group_id}, {projection : {"list" : {$slice : [--id, 1]}, "done" : 0}});
                mongo.close();
                resolve(res.list[0] ? /\d{19}/.exec(res.list[0])[0] : false);
                return;
            });
        }
        catch(err) {
            console.error(err);
            reject(false);
            return;
        }
    })
}

async function serveDone(context) {
    let tweet_id = 0;
    if (/https:\/\/twitter.com\/.+?\/status\/\d{19}/.test(context.message)) {
        tweet_id = /\d{19}/.exec(context.message)[0];
    }
    else {
        const group_id = context.group_id;
        let id = parseInt(/\d{1,4}/.exec(context.message)[0]);
        if (id == 0) {
            replyFunc(context, "没有0", true);
            return;
        }
        tweet_id = await retriveUrl(group_id, id);
    }

    let img_path = path.join(STORAGEPATH, `${tweet_id}.jpg`);
    fs.access(img_path, fs.constants.F_OK, err => {
        let text = err ? "锅里没有这片锅巴" : `[CQ:image,file=file:///${img_path}]`
        replyFunc(context, text);
    });
    return;
}

async function serveMedium(context) {
    let tweet_id = 0;
    const group_id = context.group_id;

    if (/https:\/\/twitter.com\/.+?\/status\/\d{19}/.test(context.message)) {
        tweet_id = /\d{19}/.exec(context.message)[0];
    }
    else {
        let id = parseInt(/\d{1,4}/.exec(context.message)[0]);
        if (id == 0) {
            replyFunc(context, "没有0", true);
            return;
        }
        tweet_id = await retriveUrl(group_id, id);
    }

    try {
        let mongo = await mongodb(DB_PATH, {useUnifiedTopology: true}).connect();
        const twe_sum = mongo.db('bot').collection('twe_sum');
        const res = await twe_sum.findOne({group_id : group_id},
            {projection : {"done" : {$elemMatch : {"tweet_id" : tweet_id}}, "list" : 0, "rare" : 0}});
        mongo.close();

        let text = ("done" in res && res.done[0]) ? formatTranslated(res.done[0].trans_args)
            : "这饭都馊了，早扔掉了";
        replyFunc(context, text);
        return;
    }
    catch(err) {
        console.error(err);
        return;
    }
}

async function serveRare(context) {
    const group_id = context.group_id;
    let id = parseInt(/\d{1,4}/.exec(context.message)[0]);
    if (id == 0) {
        replyFunc(context, "没有0", true);
        return;
    }
    let tweet_id = await retriveUrl(group_id, id);
    if (!tweet_id) replyFunc(context, "没有这条推", true);
    else twitter.rtSingleTweet(tweet_id, context);
}

async function disposeSingle(group_id, which, id) {
    return new Promise(async (resolve, reject) => {
        try {
            let mongo = await mongodb(DB_PATH, {useUnifiedTopology: true}).connect();
            const twe_sum = mongo.db('bot').collection('twe_sum');
            let res = await twe_sum.updateOne({group_id : group_id}, {$pull : {[which] : {"id" : id}}});
            mongo.close();
            resolve(res.modifiedCount > 0 ? true : false);
            return;
        }
        catch(err) {
            console.error(err);
            reject(false);
            return;
        }
    })
}

function disposeRare(context) {
    let id = parseInt(/\d{1,4}/.exec(context.message)[0]);
    disposeSingle(context.group_id, "rare", id).then(res => {
        let text = res ? "这米扔了" : "没有这粒米";
        replyFunc(context, text);
    }).catch(err => {
        replyFunc(context, "抛米异常");
    });
}

async function disposeDone(context) {
    let id = parseInt(/\d{1,4}/.exec(context.message)[0]);
    disposeSingle(context.group_id, "done", id).then(res => {
        let text = res ? "这锅巴飞了" : "没有这块锅巴";
        replyFunc(context, text);
    }).catch(err => {
        replyFunc(context, "飞锅巴异常");
    });
}

async function disposeAll(group_id, which) {
    return new Promise(async (resolve, reject) => {
        try {
            let mongo = await mongodb(DB_PATH, {useUnifiedTopology: true}).connect();
            const twe_sum = mongo.db('bot').collection('twe_sum');
            await twe_sum.updateOne({group_id : group_id}, {$set : {[which] : []}});
            mongo.close();
            resolve(true);
            return;
        }
        catch(err) {
            console.error(err);
            reject(false);
            return;
        }
    })
}

function disposeAllRare(context) {
    disposeAll(context.group_id, "rare").then(res => {
        replyFunc(context, "米缸空了");
    }).catch(err => {
        replyFunc(context, "踢缸异常");
    });
}

function disposeAllDone(context) {
    disposeAll(context.group_id, "done").then(res => {
        replyFunc(context, "锅里空了");
    }).catch(err => {
        replyFunc(context, "掀锅异常");
    });
}

function seasoning(context, id = "") {
    let raw = context.message.replace(/\r\n|\n/g, "<br>");
    try {
        let {groups : {twitter_url, username, tweet_id}} = /(?<twitter_url>https:\/\/twitter\.com\/(?<username>.+?)\/status\/(?<tweet_id>\d+))(?:\?s=\d{1,2})?/i.exec(raw);
        let text_index = /https:\/\/twitter\.com\/\w+?\/status\/\d+(?:\?s=\d{1,2})?/.exec(raw);
        let text = raw.substring(text_index.index + text_index[0].length);

        findTemplate(username, context.group_id).then(saved_trans_args => {
            if (!saved_trans_args) saved_trans_args = JSON.parse(JSON.stringify(defaultTemplate));
            if (/^(\s|[>＞]{1,2}|<br>)/.test(text)) {
                text = text.replace(/^(\s|[>＞]{1,2}|<br>)/, "").trim();
                text = text.substring(starter[1].length).trim().replace(/^<br>/, "");
                saved_trans_args.article.origin = text;
                storeRecentTranslation(context.group_id, twitter_url, tweet_id, id, saved_trans_args);
                cook(context, twitter_url, saved_trans_args);
            }
            else if (/^[>＞]/.test(text)) {
                text = text.substring(1).trim();
                let {trans_args, err} = setTemplate(text);
                if (err) {
                    replyFunc(context, err, true);
                    return;
                };
                [saved_trans_args, trans_args].reduce((prev, next) => {
                    for (let key in prev) {
                        if (typeof(prev[key]) == "object") {
                            next[key] = {...prev[key], ...next[key]};
                        }
                        else next[key] = next[key] != undefined ? next[key] : prev[key];
                    }
                    return next;
                });

                if (!('trans_html' in trans_args) && !('origin' in trans_args.article)
                    && !('reply' in trans_args.article) && !('serialTrans' in trans_args.article)) {
                    replyFunc(context, "你没加翻译", true);
                    return;
                }
                if ("serialTrans" in trans_args.article) {
                    if ('origin' in trans_args.article || 'reply' in trans_args.article || 'quote' in trans_args.article) {
                        replyFunc(context, "连续翻译不可以和其他文字选项同时出现", true);
                        return;
                    }
                    else if (trans_args.article.serialTrans.length > 5) {
                        replyFunc(context, "连烤太长会爆掉的", true);
                        return;
                    }
                    else serialTweet(context, twitter_url, trans_args);
                }
                else {
                    storeRecentTranslation(context.group_id, twitter_url, tweet_id, id, trans_args);
                    // cook(context, twitter_url, trans_args);
                    queue.add(cook, context, twitter_url, trans_args);
                    if (queue.jobRemain() <= 1) queue.do();
                    else {
                        replyFunc(context, `你前面还有${queue.jobRemain() - 1}个人`);
                    }
                }
            }
            else {
                replyFunc(context, "语法错误");
                throw "语法错误";
            }
        });
    } catch(err) {
        console.error(err);
        replyFunc(context, "出错惹");
    }
}

function prepare(context) {
    try {
        const group_id = context.group_id;
        const num = parseInt(/\d{1,4}/.exec(context.message)[0]);
        if (num == 0) {
            replyFunc(context, "不要乱搞啊这从1开始计数的", true);
            return;
        }
        mongodb(DB_PATH, {useUnifiedTopology: true}).connect().then(async mongo => {
            const twe_sum = mongo.db('bot').collection('twe_sum');
            const summ = await twe_sum.findOne({group_id : group_id});

            if (!summ) replyFunc(context, "告诉管理员数据库挂了");
            else if (summ.list.length < num) replyFunc(context, "不要乱输数字！", true);
            else {
                let twitter_url = summ.list[num - 1];
                context.message = context.message.replace(num, twitter_url);
                if (/^(Twitter|推特)?截图/i.test(context.message)) cook(context, twitter_url);
                else seasoning(context, num);
            }
            mongo.close();
        });
    }
    catch(err) {
        console.error(err);
        replyFunc(context, "出错惹", true);
    }
}

function checkPermission(context) {
    if (/owner|admin/.test(context.sender.role)) return true;
    else {
        replyFunc(context, "您配吗");
        return false;
    }
}

function complex(context) {
    if (connection && /^(推特|Twitter)?截图\s?https:\/\/twitter.com\/.+?\/status\/\d{18,19}/i.test(context.message)) {
        let twitter_url = /https:\/\/twitter.com\/.+?\/status\/\d{18,19}/i.exec(context.message)[0];
        cook(context, twitter_url);
        return true;
    }
    else if (connection && /^(推特|Twitter)截图\s?\d{1,4}/i.test(context.message)) {
        prepare(context);
        return true;
    }
    else if (connection && /^烤制\s?https:\/\/twitter.com\/.+?\/status\/\d{18,19}(?:\?s=\d{1,2})?\s?([>＞]{1,2}|\s|\r\n)/i.test(context.message)) {
        seasoning(context);
        return true;
    }
    else if (connection && /^烤制\s?\d{1,4}([>＞]{1,2}|\s|\r\n)/i.test(context.message)) {
        prepare(context);
        return true;
    }
    else if (/^保存烤制模板\s?https:\/\/twitter.com\/.+(?:\/)?[>＞].+/.test(context.message)) {
        let plain = context.message.replace(/\r\n/g, "");
        let {groups : {username, unparsed}} = /https:\/\/twitter.com\/(?<username>.+?)(?:\/status\/\d+)?[>＞](?<unparsed>.+)/.exec(plain);
        saveTemplate(context, username, unparsed);
        return true;
    }
    else if (/^(来把)?米\d{1,4}$/.test(context.message)) {
        serveRare(context);
        return true;
    }
    else if (/^(来碗)?饭(\d{1,4}|https:\/\/twitter.com\/.+?\/status\/\d{18,19}(?:\?s=\d{1,2})?)$/.test(context.message)) {
        serveMedium(context);
        return true;
    }
    else if (/^(来片)?锅巴(\d{1,4}|https:\/\/twitter.com\/.+?\/status\/\d{18,19}(?:\?s=\d{1,2})?)$/.test(context.message)) {
        serveDone(context);
        return true;
    }
    else if (/^(不要|扔掉)米\d{1,4}$/.test(context.message)) {
        disposeRare(context);
        return true;
    }
    else if (/^(不要|扔掉)锅巴\d{1,4}/.test(context.message)) {
        disposeDone(context);
        return true;
    }
    else if (/^踢翻米缸$/.test(context.message)) {
        if (!checkPermission(context)) return true;
        disposeAllRare(context);
        return true;
    }
    else if (/^掀掉锅子$/.test(context.message)) {
        if (!checkPermission(context)) return true;
        disposeAllDone(context);
        return true;
    }
    else if (/^打开锅盖$/.test(context.message)) {
        bbqRisidue(context);
        return true;
    }
    else if (/^烤推说明书$/.test(context.message)) {
        replyFunc(context, "看这里\na-wsl.com/Caster");
        return true;
    }
    else if (/^锅子说明书$/.test(context.message)) {
        replyFunc(context, "打开锅盖 => (不要|扔掉)米/锅巴 => 踢翻米缸/掀掉锅子");
        return true;
    }
    else return false;
}

export default {complex, cookTweReply};