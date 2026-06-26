require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const cron = require('node-cron');

const app = express();

// ─── LINE設定 ────────────────────────────────────────────────────────────────
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  channelSecret: process.env.LINE_CHANNEL_SECRET || '',
};
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: lineConfig.channelAccessToken,
});

// ─── 監視エリア ───────────────────────────────────────────────────────────────
const MONITOR_AREAS = {
  '450000': '宮崎県',
};

// 気象庁 警報コード（台風関連）
// 4: 暴風特別警報, 5: 暴風警報, 6: 暴風雪特別警報, 7: 暴風雪警報
const TYPHOON_WARNING_CODES = new Set([4, 5, 6, 7]);

// ─── 台風状態管理 ─────────────────────────────────────────────────────────────
let typhoonState = {
  approachNotified: false,
  passedNotified: false,
  notifiedAt: null,
};

// ─── ルーター ─────────────────────────────────────────────────────────────────
app.use(express.json());

app.get('/webhook', (req, res) => res.status(200).send('OK'));

app.post('/webhook', (req, res) => {
  res.status(200).send('OK');
  const events = req.body?.events || [];
  events.forEach(handleLineEvent);
});

app.get('/admin/status', (req, res) => {
  res.json({
    status: 'running',
    monitorAreas: Object.values(MONITOR_AREAS),
    typhoonState: {
      approachNotified: typhoonState.approachNotified,
      passedNotified: typhoonState.passedNotified,
      notifiedAt: typhoonState.notifiedAt,
    },
    uptime: `${Math.floor(process.uptime())}秒`,
    timestamp: now(),
  });
});

app.get('/admin/preview/pre', (req, res) => {
  res.json(createApproachFlex().contents);
});

// テスト送信エンドポイント
app.get('/admin/test/approach', async (req, res) => {
  try {
    await broadcastMessage(createApproachFlex());
    res.json({ success: true, message: '台風接近通知を送信しました' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/admin/test/passed', async (req, res) => {
  try {
    await broadcastMessage(createPassedFlex());
    res.json({ success: true, message: '台風通過通知を送信しました' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 気象庁の実データから現在の台風情報を取得してテスト送信
app.get('/admin/test/current', async (req, res) => {
  try {
    const summary = await fetchRelevantTyphoonSummary();
    if (!summary) {
      return res.json({ success: false, message: '現在、宮崎県に関係する台風は発生していません' });
    }
    await broadcastMessage(createApproachFlex(summary));
    res.json({ success: true, message: '現在の台風情報を送信しました', summary });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

function handleLineEvent(event) {
  if (event.type === 'message' && event.message?.type === 'text') {
    const text = event.message.text;
    if (text === '台風情報') {
      const status = typhoonState.approachNotified
        ? '台風接近警報を発令中です。安全な場所に避難してください。'
        : '現在、監視エリアへの台風接近は検知されていません。';
      client.replyMessage({
        replyToken: event.replyToken,
        messages: [{ type: 'text', text: status }],
      }).catch(console.error);
    }
  }
}

// ─── 気象庁API ────────────────────────────────────────────────────────────────
async function fetchWarnings(areaCode) {
  try {
    const res = await axios.get(
      `https://www.jma.go.jp/bosai/warning/data/warning/${areaCode}.json`,
      { timeout: 10000 }
    );
    return res.data;
  } catch (err) {
    console.error(`[警告取得失敗] エリア ${areaCode}: ${err.message}`);
    return null;
  }
}

function hasTyphoonWarning(warningData) {
  if (!warningData?.areaTypes) return false;
  for (const areaType of warningData.areaTypes) {
    for (const area of areaType.areas || []) {
      for (const warning of area.warnings || []) {
        if (warning.status === '発表' && TYPHOON_WARNING_CODES.has(warning.code)) {
          return true;
        }
      }
    }
  }
  return false;
}

// ─── 台風実況データ → 文章化 ────────────────────────────────────────────────────
// 宮崎県に関係する台風（実況または予報経路に「宮崎」「鹿児島」「奄美」「九州」を含む）を1件取得し、要約文を生成する
const MIYAZAKI_KEYWORDS = ['宮崎', '鹿児島', '奄美', '九州'];

async function fetchRelevantTyphoonSummary() {
  const { data: targets } = await axios.get(
    'https://www.jma.go.jp/bosai/typhoon/data/targetTc.json',
    { timeout: 10000 }
  );
  if (!Array.isArray(targets) || targets.length === 0) return null;

  for (const t of targets) {
    let specs;
    try {
      const res = await axios.get(
        `https://www.jma.go.jp/bosai/typhoon/data/${t.tropicalCyclone}/specifications.json`,
        { timeout: 10000 }
      );
      specs = res.data;
    } catch (err) {
      console.error(`[台風詳細取得失敗] ${t.tropicalCyclone}: ${err.message}`);
      continue;
    }

    const title = specs.find((s) => s.part === 'title');
    const analysis = specs.find((s) => s.part?.jp === '実況');
    if (!title || !analysis) continue;

    const nearMiyazaki = specs.find(
      (s) => s.location && MIYAZAKI_KEYWORDS.some((kw) => s.location.includes(kw))
    );
    if (!nearMiyazaki) continue; // この台風は宮崎と無関係なのでスキップ

    const num = title.typhoonNumber;
    const name = title.name?.jp || '';
    const loc = analysis.location || '海上';
    const pressure = analysis.pressure;
    const wind = analysis.maximumWind?.sustained?.['m/s'];
    const gust = analysis.maximumWind?.gust?.['m/s'];
    const course = analysis.course;
    const speed = analysis.speed?.['km/h'];

    let text = `台風第${num}号「${name}」は現在${loc}付近を${course}へ時速${speed}kmで進んでいます。中心気圧${pressure}hPa、最大風速${wind}m/s（最大瞬間風速${gust}m/s）。`;
    if (nearMiyazaki.advancedHours > 0) {
      text += `${nearMiyazaki.advancedHours}時間後には${nearMiyazaki.location}付近に達する見込みです。`;
    }
    text += '宮崎県への影響に注意し、早めの備えをお願いします。';

    return { num, name, text, pressure, wind, gust, course, speed, location: loc };
  }

  return null;
}

// ─── 監視メインロジック ────────────────────────────────────────────────────────
async function checkTyphoon() {
  console.log(`[${now()}] 台風監視チェック開始`);

  let approachDetected = false;

  for (const [code, name] of Object.entries(MONITOR_AREAS)) {
    const data = await fetchWarnings(code);
    if (data && hasTyphoonWarning(data)) {
      approachDetected = true;
      console.log(`[${now()}] 台風警報検知: ${name}`);
      break;
    }
  }

  if (approachDetected && !typhoonState.approachNotified) {
    // 台風接近 → 接近メッセージ送信（実況データから要約文を生成）
    const summary = await fetchRelevantTyphoonSummary().catch((err) => {
      console.error('[台風要約取得失敗]', err.message);
      return null;
    });
    await broadcastMessage(createApproachFlex(summary));
    typhoonState.approachNotified = true;
    typhoonState.passedNotified = false;
    typhoonState.notifiedAt = new Date();
    console.log(`[${now()}] 台風接近通知を送信しました`);

  } else if (!approachDetected && typhoonState.approachNotified && !typhoonState.passedNotified) {
    // 台風通過 → 通過メッセージ送信
    await broadcastMessage(createPassedFlex());
    typhoonState.passedNotified = true;
    console.log(`[${now()}] 台風通過通知を送信しました`);

    // 24時間後に状態リセット
    setTimeout(() => {
      typhoonState = { approachNotified: false, passedNotified: false, notifiedAt: null };
      console.log(`[${now()}] 台風状態をリセットしました`);
    }, 24 * 60 * 60 * 1000);
  }
}

async function broadcastMessage(flexMessage) {
  try {
    await client.broadcast({ messages: [flexMessage] });
  } catch (err) {
    console.error('[送信エラー]', err.message);
  }
}

// ─── Flexメッセージ: 台風接近 ──────────────────────────────────────────────────
function createApproachFlex(summary) {
  const areas = Object.values(MONITOR_AREAS).join('・');
  const altText = summary
    ? `【緊急警報】台風第${summary.num}号「${summary.name}」が接近中`
    : '【緊急警報】台風が九州・宮崎エリアに接近中';
  return {
    type: 'flex',
    altText,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#CC0000',
        paddingAll: '20px',
        contents: [
          {
            type: 'text',
            text: '⚠️ 台風接近警報',
            color: '#FFFFFF',
            size: 'xxl',
            weight: 'bold',
            align: 'center',
          },
          {
            type: 'text',
            text: '速やかに安全な場所へ避難してください',
            color: '#FFDDDD',
            size: 'sm',
            align: 'center',
            margin: 'sm',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '20px',
        contents: [
          ...(summary
            ? [
                {
                  type: 'box',
                  layout: 'vertical',
                  backgroundColor: '#FFF5F5',
                  cornerRadius: '8px',
                  paddingAll: '12px',
                  contents: [
                    {
                      type: 'text',
                      text: `台風第${summary.num}号「${summary.name}」`,
                      weight: 'bold',
                      size: 'md',
                      color: '#CC0000',
                    },
                    {
                      type: 'text',
                      text: summary.text,
                      size: 'sm',
                      color: '#333333',
                      wrap: true,
                      margin: 'sm',
                    },
                  ],
                },
              ]
            : []),
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'text',
                text: '対象エリア',
                size: 'sm',
                color: '#888888',
                flex: 2,
              },
              {
                type: 'text',
                text: areas,
                size: 'sm',
                color: '#333333',
                wrap: true,
                flex: 5,
              },
            ],
          },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'text',
                text: '発報時刻',
                size: 'sm',
                color: '#888888',
                flex: 2,
              },
              {
                type: 'text',
                text: now(),
                size: 'sm',
                color: '#333333',
                flex: 5,
              },
            ],
          },
          { type: 'separator', margin: 'md' },
          {
            type: 'text',
            text: '【緊急行動チェックリスト】',
            size: 'md',
            weight: 'bold',
            color: '#CC0000',
            margin: 'md',
          },
          checklist('🏠 自宅・事業所の戸締まりを確認'),
          checklist('📦 非常用持ち出し袋を準備'),
          checklist('🌊 浸水・土砂災害の危険がある場合は避難'),
          checklist('📱 ハザードマップ・避難情報を確認'),
          { type: 'separator', margin: 'md' },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#EEF4FF',
            cornerRadius: '8px',
            paddingAll: '12px',
            margin: 'md',
            contents: [
              {
                type: 'text',
                text: '📋 保険に関するご案内',
                size: 'sm',
                weight: 'bold',
                color: '#0055CC',
              },
              {
                type: 'text',
                text: '台風による損害が発生した場合は、被害箇所を写真撮影のうえ、速やかに担当代理店または保険会社へご連絡ください。',
                size: 'xs',
                color: '#333333',
                wrap: true,
                margin: 'sm',
              },
            ],
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '16px',
        contents: [
          {
            type: 'button',
            action: {
              type: 'uri',
              label: '気象庁 台風情報',
              uri: 'https://www.jma.go.jp/jma/index.html',
            },
            style: 'primary',
            color: '#CC0000',
            height: 'sm',
          },
          {
            type: 'button',
            action: {
              type: 'uri',
              label: '避難情報・ハザードマップ',
              uri: 'https://disaportal.gsi.go.jp/',
            },
            style: 'secondary',
            height: 'sm',
          },
        ],
      },
    },
  };
}

// ─── Flexメッセージ: 台風通過 ──────────────────────────────────────────────────
function createPassedFlex() {
  const areas = Object.values(MONITOR_AREAS).join('・');
  return {
    type: 'flex',
    altText: `【解除】台風が九州・宮崎エリアを通過しました`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#007A3D',
        paddingAll: '20px',
        contents: [
          {
            type: 'text',
            text: '✅ 台風通過のお知らせ',
            color: '#FFFFFF',
            size: 'xxl',
            weight: 'bold',
            align: 'center',
          },
          {
            type: 'text',
            text: '暴風警報が解除されました',
            color: '#CCFFDD',
            size: 'sm',
            align: 'center',
            margin: 'sm',
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        paddingAll: '20px',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'text',
                text: '対象エリア',
                size: 'sm',
                color: '#888888',
                flex: 2,
              },
              {
                type: 'text',
                text: areas,
                size: 'sm',
                color: '#333333',
                wrap: true,
                flex: 5,
              },
            ],
          },
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'text',
                text: '解除時刻',
                size: 'sm',
                color: '#888888',
                flex: 2,
              },
              {
                type: 'text',
                text: now(),
                size: 'sm',
                color: '#333333',
                flex: 5,
              },
            ],
          },
          { type: 'separator', margin: 'md' },
          {
            type: 'text',
            text: '台風は通過しましたが、引き続き二次災害にご注意ください。',
            size: 'sm',
            color: '#333333',
            wrap: true,
            margin: 'md',
          },
          {
            type: 'text',
            text: '【台風通過後の確認事項】',
            size: 'md',
            weight: 'bold',
            color: '#007A3D',
            margin: 'md',
          },
          checklist('🏠 建物・屋根・外壁の損傷確認'),
          checklist('🌊 浸水・冠水・土砂崩れの確認'),
          checklist('⚡ 電気・ガス・水道の点検'),
          checklist('🌳 倒木・落下物の除去（感電注意）'),
          { type: 'separator', margin: 'md' },
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#EEF4FF',
            cornerRadius: '8px',
            paddingAll: '12px',
            margin: 'md',
            contents: [
              {
                type: 'text',
                text: '📋 保険請求のお手続き',
                size: 'sm',
                weight: 'bold',
                color: '#0055CC',
              },
              {
                type: 'text',
                text: '損害が確認された場合は、修理前に被害状況を撮影し、担当代理店または保険会社にご連絡ください。請求書類のご案内をいたします。',
                size: 'xs',
                color: '#333333',
                wrap: true,
                margin: 'sm',
              },
            ],
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '16px',
        contents: [
          {
            type: 'button',
            action: {
              type: 'uri',
              label: '気象庁 最新気象情報',
              uri: 'https://www.jma.go.jp/jma/index.html',
            },
            style: 'primary',
            color: '#007A3D',
            height: 'sm',
          },
          {
            type: 'button',
            action: {
              type: 'uri',
              label: '保険請求のご案内（損保協会）',
              uri: 'https://www.sonpo.or.jp/',
            },
            style: 'secondary',
            height: 'sm',
          },
        ],
      },
    },
  };
}

// ─── ユーティリティ ───────────────────────────────────────────────────────────
function now() {
  return new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

function checklist(text) {
  return {
    type: 'text',
    text,
    size: 'sm',
    color: '#444444',
    margin: 'sm',
    wrap: true,
  };
}

// ─── cronスケジュール (30分ごと) ──────────────────────────────────────────────
cron.schedule('*/30 * * * *', () => {
  checkTyphoon().catch(console.error);
});

// ─── サーバー起動 ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`台風監視LINEボット起動 [ポート ${PORT}]`);
  console.log('監視エリア:', Object.values(MONITOR_AREAS).join(', '));
  console.log('最初の台風チェックを実行中...');
  checkTyphoon().catch(console.error);
});
