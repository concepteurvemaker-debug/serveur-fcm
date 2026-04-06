Ajouts necessaires dans le projet Android :

Manifest :
- `android.permission.INTERNET`
- `android.permission.ACCESS_FINE_LOCATION`
- `android.permission.ACCESS_COARSE_LOCATION`
- `android.permission.POST_NOTIFICATIONS` (Android 13+)

Service a declarer dans `AndroidManifest.xml` :

```xml
<service
    android:name=".EmergencyMessagingService"
    android:exported="false">
    <intent-filter>
        <action android:name="com.google.firebase.MESSAGING_EVENT" />
    </intent-filter>
</service>
```

Dependances cote app :
- Firebase Messaging
- OkHttp
- Google Play Services Location

Notes :
- Le `MainActivity` fourni fonctionne surtout quand l'app est ouverte.
- Pour un vrai suivi en arriere-plan cote secours, il faudra ensuite passer sur un `ForegroundService`.
- Le mode public doit aussi envoyer sa position au serveur, sinon le backend ne peut pas savoir qui est dans le rayon des 150 m.
