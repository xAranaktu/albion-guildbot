'use strict';

require('babel-polyfill');

const Discord = require('discord.js');
const moment = require('moment');
moment.locale('pl')
const FileSync = require('lowdb/adapters/FileSync');
const logger = require('winston');
const low = require('lowdb');

const Albion = require('./AlbionApi');
const Battle = require('./Battle').default;
const { createImage, getItemUrl } = require('./createImage');

const config = require('../config');

const adapter = new FileSync('.db.json');
const db = low(adapter);
db.defaults({ recents: { battleId: 0, eventId: 0 } }).write();

const footer_logo_url = "https://i.imgur.com/4F09qpA.png";

// Heroku will crash if we're not listenining on env.PORT.
if (process.env.HEROKU) {
  const Express = require('express');
  const app = new Express();
  app.listen(process.env.PORT || 1337);
}

// Configure logger settings
logger.remove(logger.transports.Console);
logger.add(logger.transports.Console, { colorize: true });
logger.level = 'debug';

// Read eventID file to get a list of all posted events
// If this fails, we cannot continue, so throw an exception.
let lastBattleId = db.get('recents.battleId').value();
let lastEventId = db.get('recents.eventId').value();
let lastAlbionStatus = db.get('recents.albionStatus').value();
let lastAlbionStatusMsg = db.get('recents.albionStatusMsg').value();

// Initialize Discord Bot
const bot = new Discord.Client();

bot.on('ready', () => {
  logger.info('Connected');
  logger.info(`Logged in as: ${bot.user.username} - (${bot.user.id})`);

  checkBattles();
  checkKillboard();

  setInterval(checkBattles, 60000);
  setInterval(checkKillboard, 30000);
});

function checkBattles() {
  logger.info('Checking battles...');
  Albion.getBattles({ limit: 20, offset: 0 }).then(battles => {
    battles
      // Filter out battles that have already been processed
      .filter(battleData => battleData.id > lastBattleId)
      // Format the raw battle data into a more useful Battle object
      .map(battleData => new Battle(battleData))
      // Filter out battles with insigificant amounts of players
      .filter(battle => battle.players.length >= config.battle.minPlayers)
      // Filter out battles that don't involve a relevent number of guildmates
      .filter(battle => {
        const relevantPlayerCount = config.guild.guilds.reduce((total, guildName) => {
          return total + (battle.guilds.has(guildName)
            ? battle.guilds.get(guildName).players.length
            : 0);
        }, 0);

        return relevantPlayerCount >= config.battle.minRelevantPlayers;
      }).forEach(battle => sendBattleReport(battle));
  });
}

function sendBattleReport(battle, channelId) {
    logger.info('sendBattleReport...');
  if (battle.id > lastBattleId) {
    lastBattleId = battle.id;
    db.set('recents.battleId', lastBattleId).write();
  }
    
  let battleChannelId = config.discord.feedChannelId

  const title = battle.rankedFactions.slice()
    .sort((a, b) => b.players.length - a.players.length)
    .map(({ name, players }) => `${name}(${players.length})`)
    .join(' vs ');

  const thumbnailUrl = battle.players.length >= 100 ? 'https://storage.googleapis.com/albion-images/static/PvP-100.png'
    : battle.players.length >= 40 ? 'https://storage.googleapis.com/albion-images/static/PvP-40.png'
    : battle.is5v5 ? 'https://storage.googleapis.com/albion-images/static/5v5-3.png'
    : 'https://storage.googleapis.com/albion-images/static/PvP-10.png';

  let fields = battle.rankedFactions.map(({ name, kills, deaths, killFame, factionType }, i) => {
    return {
      name: `${i + 1}. ${name} - ${killFame.toLocaleString()} Fame`,
      inline: true,
      value: [
        `Kills: ${kills}`,
        `Deaths: ${deaths}`,
        factionType === 'alliance' ? '\n__**Guilds**__' : '',
        Array.from(battle.guilds.values())
          .filter(({ alliance }) => alliance === name)
          .sort((a, b) => battle.guilds.get(b.name).players.length  > battle.guilds.get(a.name).players.length)
          .map(({ name }) => `${name} (${battle.guilds.get(name).players.length})`)
          .join('\n'),
      ].join('\n')
    };
  });

  if (battle.is5v5) {
    battleChannelId = config.discord._5v5ChannelId
    fields = battle.rankedFactions.map(({ name, kills, players }) => {
      return {
        name: `${name} [Kills: ${kills}]`,
        inline: true,
        value: players
          .sort((a, b) => a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1)
          .sort((a, b) => b.kills > a.kills)
          .map(({ name, kills, deaths }) => `${deaths ? '~~' : ''}${name}${deaths ? '~~' : ''}: ${kills} Kills`)
          .join('\n')
      };
    });
  }

  const didWin = battle.rankedFactions[0].name === config.guild.alliance;

  const embed = {
    url: `https://albiononline.com/en/killboard/battles/${battle.id}`,
    description: battle.is5v5
      ? `Winner's Fame: ${battle.rankedFactions[0].killFame.toLocaleString()}`
      : `Players: ${battle.players.length}, Kills: ${battle.totalKills}, Fame: ${battle.totalFame.toLocaleString()}`,
    title: battle.is5v5
      ? (didWin ? `We wrecked ${battle.rankedFactions[1].name} in a 5v5!` : `We lost to ${battle.rankedFactions[0].name} in a 5v5!`)
      : title,
    color: didWin ? 65280 : 16711680,
    footer: {
      icon_url: footer_logo_url,
      text: get_footer("Battleboard"), 
    },
    thumbnail: { url: thumbnailUrl },
    image: { url: 'https://storage.googleapis.com/albion-images/static/spacer.png' },
    fields,
  };

  bot.channels.get(battleChannelId).send({ embed }).then(() => {
    logger.info(`Successfully posted log of battle between ${title}.`);
  }).catch(err => {
    logger.error(err);
  });
}

function sendKillReport(event, channelId) {
    logger.info('sendKillReport...');
  const isFriendlyKill = config.guild.guilds.indexOf(event.Killer.GuildName) !== -1;

  createImage('Victim', event).then(imgBuffer => {
    const participants = parseInt(event.numberOfParticipants || event.GroupMembers.length, 10);
    const assists = participants - 1;

    const embed = {
      url: `https://albiononline.com/en/killboard/kill/${event.EventId}`,
      title: `${event.Killer.Name} (${assists ? '+' + assists : 'Solo!'}) just killed ${event.Victim.Name}!`,
      description: `From guild: ${createGuildTag(event[isFriendlyKill ? 'Victim' : 'Killer'])}`,
      color: isFriendlyKill ? 65280 : 16711680,
      footer: {
        icon_url: footer_logo_url,
        text: get_footer("Killboard"), 
      },
      image: { url: 'attachment://kill.png' },
    };

    if (event.TotalVictimKillFame > config.kill.minFame) {
      Object.assign(embed, {
        thumbnail: { url: getItemUrl(event.Killer.Equipment.MainHand) },
        title: `${event.Killer.Name} just killed ${event.Victim.Name}!`,
        description: assists
          ? `Assisted by ${assists} other player${assists > 1 ? 's' : ''}.`
          : 'Solo kill!',
        fields: [{
          name: isFriendlyKill ? 'Victim\'s Guild' : 'Killer\'s Guild',
          value: createGuildTag(event[isFriendlyKill ? 'Victim' : 'Killer']),
          inline: true,
        }],
      });
    }

    const files = [{ name: 'kill.png', attachment: imgBuffer }];

    return bot.channels.get(config.discord.solokillChannelId).send({ embed, files });
  }).then(() => {
    logger.info(`Successfully posted log of ${createDisplayName(event.Killer)} killing ${createDisplayName(event.Victim)}.`);
  });
}

function checkKillboard() {
  logger.info('Checking killboard...');
  Albion.getEvents({ limit: 51, offset: 0 }).then(events => {
    if (!events) { return; }

    events.sort((a, b) => a.EventId - b.EventId)
      .filter(event => event.EventId > lastEventId)
      .forEach(event => {
        lastEventId = event.EventId;

        const isFriendlyKill = config.guild.guilds.indexOf(event.Killer.GuildName) !== -1;
        const isFriendlyDeath = config.guild.guilds.indexOf(event.Victim.GuildName) !== -1;

        if (!(isFriendlyKill || isFriendlyDeath) || event.TotalVictimKillFame < 10000) {
          return;
        }

        sendKillReport(event);
      });

    db.set('recents.eventId', lastEventId).write();
  });
}

function createGuildTag(player) {
  const allianceTag = player.AllianceName ? `[${player.AllianceName}]` : '';
  return player.GuildName ? `${allianceTag} ${player.GuildName}` : 'N/A';
}

function createDisplayName(player) {
  const allianceTag = player.AllianceName ? `[${player.AllianceName}]` : '';
  return `**<${allianceTag}${player.GuildName || 'Unguilded'}>** ${player.Name}`;
}

function get_footer(text_to_set) {
    let now = moment().format('LLLL');
    return `${text_to_set} | ${now}`;
}

function test_footer() {
  let now = new Date();
  let days = ['Niedziela', 'Poniedziałek', 'Wtorek', 'Środa', 'Czwartek', 'Piątek', 'Sobota'];
  let months = ['styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec', 'lipiec', 'sierpień', 'wrzesień', 'październik', 'grudzień'];
  let day = now.getDate();
  let day_name = days[now.getDay()];
  let month_name = months[now.getMonth()];
  let year = now.getFullYear();
  let hour = now.getHours()

  const embed = {
    title: 'Albion Status Information',
    description: 'blblel',
    color: 16711680,
    fields: [{
      name: 'Message',
      value: 'abc',
      inline: true,
    }],
    footer: {
      icon_url: footer_logo_url,
      text: get_footer("TEST"), 
    }
  };

  bot.channels.get(config.discord.feedChannelId).send({ embed }).then(() => {
    logger.info(`Successfully posted albion test`);
  }).catch(err => {
    logger.error(err);
  });
}

bot.login(config.discord.token);
