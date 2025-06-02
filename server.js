// server.js - Ko-Fi Webhook to Firebase Integration
const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const axios = require('axios'); // Discord通知用のHTTPリクエスト
const app = express();
require('dotenv').config();

// Firebase設定
// 注意: 実際のプロジェクトでは環境変数を使用することを推奨します
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  token_uri: "https://oauth2.googleapis.com/token"
};

// Discord Webhook URL - 環境変数から取得することを推奨
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || 'https://discord.com/api/webhooks/1363823200978599956/aSyhuGVtYc5OtfsomZNcyFScvX9-nR6n-XWWRnWtiLPOC8jQK-E5chBBQ5bE5kmPFRR9';

// Firebaseの初期化
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://your-firebase-project.firebaseio.com"
});

const db = admin.firestore();

// expressの設定
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Discordに通知を送信する関数
async function sendDiscordNotification(purchaseData) {
  try {
    const { email, deviceId, itemName, amount, transactionId } = purchaseData;
    
    // Discord用のメッセージを構築
    const embed = {
      title: '🎉 新しい購入がありました！',
      color: 0x00ff00, // 緑色
      fields: [
        {
          name: '商品',
          value: itemName || '不明',
          inline: true
        },
        {
          name: '金額',
          value: `${amount || 0}`,
          inline: true
        },
        {
          name: '取引ID',
          value: transactionId || '不明',
          inline: false
        }
      ],
      timestamp: new Date().toISOString(),
      footer: {
        text: 'Ko-Fi Webhook'
      }
    };
    
    // メールアドレスがあれば追加
    if (email) {
      embed.fields.push({
        name: 'メールアドレス',
        value: email,
        inline: false
      });
    }
    
    // デバイスIDがあれば追加
    if (deviceId) {
      embed.fields.push({
        name: 'デバイスID',
        value: deviceId,
        inline: false
      });
    }
    
    // Discordにメッセージを送信
    await axios.post(DISCORD_WEBHOOK_URL, {
      embeds: [embed]
    });
    
    console.log('Discordに通知を送信しました');
  } catch (error) {
    console.error('Discord通知の送信に失敗しました:', error);
  }
}

// Ko-Fi Webhookエンドポイント
app.post('/webhook', async (req, res) => {
  try {
    // Ko-Fiからのデータ検証
    const data = req.body.data;
    if (!data) {
      console.log('データがありません');
      return res.status(400).send('データがありません');
    }

    console.log('受信したWebhookデータ:', data);

    // Ko-Fiの購入情報を解析
    const kofiData = JSON.parse(data);
    
    // 購入者のメールアドレスを取得
    const email = kofiData.email || '';
    if (!email) {
      console.log('メールアドレスが見つかりませんでした');
    } else {
      console.log(`メールアドレスを取得しました: ${email}`);
    }
    
    // 特定の商品IDまたは商品名をチェック (オプション: すべての購入を保存する場合は削除可能)
    const targetItems = ['82df911f7d']; // 監視対象の商品ID/名前
    const itemName = kofiData.shop_items?.[0]?.direct_link_code || kofiData.tier_name || '';
    
    // 特定の商品のみを保存する場合はこちらを使用
    if (targetItems.some(item => itemName.includes(item))) {
      // デバイスIDを取得 (URLパラメータかメッセージから)
      let deviceId = '';
      
      // メッセージからデバイスIDを探す
      if (kofiData.message) {
        const deviceIdMatch = kofiData.message.match(/device[_\s]?id:?\s*([a-zA-Z0-9-]+)/i);
        if (deviceIdMatch && deviceIdMatch[1]) {
          deviceId = deviceIdMatch[1];
        }
      }
      
      // URLからデバイスIDを探す
      if (!deviceId && kofiData.from_url) {
        const urlParams = new URL(kofiData.from_url).searchParams;
        deviceId = urlParams.get('device_id') || '';
      }
      
      // 購入データを準備
      const licenseData = {
        purchaseDate: admin.firestore.Timestamp.now(),
        transactionId: kofiData.kofi_transaction_id || '',
        itemName: itemName,
        amount: kofiData.amount || 0
      };
      
      // デバイスIDまたはメールアドレスが存在する場合に追加
      if (deviceId) licenseData.deviceId = deviceId;
      if (email) licenseData.email = email;
      
      // Firebaseに記録 - deviceIdがなくてもメールアドレスがあれば保存
      if (email || deviceId) {
        // 購入情報をFirebaseに保存
        const docRef = await db.collection('licenses').add(licenseData);
        
        console.log(`購入情報をFirebaseに保存しました - ドキュメントID: ${docRef.id}`);
        console.log(`- デバイスID: ${deviceId || 'なし'}`);
        console.log(`- メールアドレス: ${email || 'なし'}`);
        
        // メールアドレスだけのコレクションを別途保存する場合
        if (email) {
          await db.collection('customer_emails').doc(email).set({
            email: email,
            lastPurchase: admin.firestore.Timestamp.now(),
            transactionIds: admin.firestore.FieldValue.arrayUnion(kofiData.kofi_transaction_id || '')
          }, { merge: true });
          
          console.log(`メールアドレス: ${email} を customer_emails コレクションに保存しました`);
        }
        
        // Discordに通知を送信
        await sendDiscordNotification({
          email,
          deviceId,
          itemName,
          amount: kofiData.amount,
          transactionId: kofiData.kofi_transaction_id
        });
      } else {
        console.log('デバイスIDもメールアドレスも見つかりませんでした');
      }
    } else {
      console.log('対象外の商品です:', itemName);
    }
    
    res.status(200).send('Webhook received');
  } catch (error) {
    console.error('エラーが発生しました:', error);
    res.status(500).send('Internal Server Error');
  }
});

// サーバー起動
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`サーバーが起動しました: http://localhost:${PORT}`);
});

// 簡単なホームページ
app.get('/', (req, res) => {
  res.send('Ko-Fi Webhook Handler is running!');
});