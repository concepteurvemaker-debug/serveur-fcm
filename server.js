const express = require('express')
const bodyParser = require('body-parser')
const admin = require('firebase-admin')

const app = express()
app.use(bodyParser.json())

// 🔑 Import du fichier Firebase (IMPORTANT)
const serviceAccount = require('./fcm-service.json')

// 🔥 Initialisation Firebase
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
})

// ✅ Route test
app.get('/', (req, res) => {
  res.send('Serveur FCM OK 🚀')
})

// 🔔 Route pour envoyer notification à tous
app.get('/send', async (req, res) => {

  const message = {
    notification: {
      title: '🔥 Nouvelle alerte',
      body: 'Ceci est une notification envoyée à tous !'
    },
    topic: 'all'
  }

  try {
    const response = await admin.messaging().send(message)
    console.log('Notification envoyée :', response)
    res.send('Notification envoyée ✅')
  } catch (error) {
    console.error(error)
    res.send('Erreur ❌')
  }
})

// 🚀 Lancement serveur
app.listen(3000, () => {
  console.log('Running on port 3000')
})