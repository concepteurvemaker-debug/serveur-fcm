Ajouts necessaires dans le projet Android :

Manifest :
- `android.permission.INTERNET`
- `android.permission.ACCESS_FINE_LOCATION`
- `android.permission.ACCESS_COARSE_LOCATION`
- `android.permission.POST_NOTIFICATIONS` (Android 13+)
- `android.permission.FOREGROUND_SERVICE`
- `android.permission.FOREGROUND_SERVICE_LOCATION`

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

Service de suivi secours a declarer aussi :

```xml
<service
    android:name=".LocationForegroundService"
    android:exported="false"
    android:foregroundServiceType="location" />
```

Dependances cote app :
- Firebase Messaging
- OkHttp
- Google Play Services Location

Notes :
- Le mode public continue d'etre gere par le `MainActivity`.
- Le mode secours actif bascule sur `LocationForegroundService` et continue a envoyer la position en arriere-plan.
- Le mode public doit aussi envoyer sa position au serveur, sinon le backend ne peut pas savoir qui est dans le rayon des 150 m.
- Le service secours doit etre demarre pendant que l'app est au premier plan. Android ne permet pas de lancer librement un foreground service de localisation depuis une app completement fermee juste parce que le telephone bouge.
