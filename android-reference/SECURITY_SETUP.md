Securisation du mode secours
===========================

Backend
-------

Les routes sensibles sont maintenant protegees :
- `POST /update-position`
- `POST /alert`
- `GET /auth-check`
- `POST /grant-secours-access`
- `POST /revoke-secours-access`

Le serveur accepte un compte secours si au moins une des conditions suivantes est vraie :
- le Firebase ID token contient `secours: true`
- le Firebase ID token contient `admin: true`
- le Firebase ID token contient `role: "secours"`
- le `uid` Firebase Auth est present dans la variable Render `SECOURS_UIDS`

Variables Render a configurer
-----------------------------

- `FIREBASE_KEY` : deja en place
- `SECOURS_UIDS` : liste separee par des virgules, par exemple `uid_1,uid_2`
- `REQUIRE_SECOURS_AUTH=true` : active par defaut si absente
- `ADMIN_SECRET` : secret fort pour accorder / retirer le role secours
- `SECOURS_EMAIL_DOMAINS` : optionnel, liste de domaines autorises, par exemple `sdis.fr,interieur.gouv.fr`

Activation d'un compte secours
------------------------------

Exemple en envoyant un email :

```http
POST /grant-secours-access
X-Admin-Secret: TON_ADMIN_SECRET
Content-Type: application/json

{
  "email": "agent@sdis.fr"
}
```

Exemple en envoyant un uid :

```http
POST /grant-secours-access
X-Admin-Secret: TON_ADMIN_SECRET
Content-Type: application/json

{
  "uid": "firebase_uid_du_compte"
}
```

Pour retirer l'acces :

```http
POST /revoke-secours-access
X-Admin-Secret: TON_ADMIN_SECRET
Content-Type: application/json

{
  "uid": "firebase_uid_du_compte"
}
```

Dependance Android
------------------

Avec Firebase BoM :

```kotlin
implementation(libs.firebase.auth)
```

ou :

```kotlin
implementation("com.google.firebase:firebase-auth")
```

Connexion secours Android
-------------------------

Exemple simple avec email / mot de passe :

```kotlin
import com.google.firebase.auth.FirebaseAuth

FirebaseAuth.getInstance()
    .signInWithEmailAndPassword(email, password)
    .addOnSuccessListener {
        Log.d("AUTH", "Connexion secours OK")
    }
    .addOnFailureListener { error ->
        Log.e("AUTH", "Connexion secours KO", error)
    }
```

Recuperer le Firebase ID token
------------------------------

```kotlin
import com.google.firebase.auth.FirebaseAuth

private fun fetchSecoursIdToken(
    forceRefresh: Boolean = false,
    onSuccess: (String) -> Unit,
    onError: (Exception?) -> Unit,
) {
    val user = FirebaseAuth.getInstance().currentUser

    if (user == null) {
        onError(IllegalStateException("Aucun utilisateur secours connecte"))
        return
    }

    user.getIdToken(forceRefresh)
        .addOnSuccessListener { result ->
            val idToken = result.token
            if (idToken.isNullOrBlank()) {
                onError(IllegalStateException("Firebase ID token vide"))
            } else {
                onSuccess(idToken)
            }
        }
        .addOnFailureListener { error ->
            onError(error)
        }
}
```

Ajouter le token a une requete OkHttp
-------------------------------------

```kotlin
private fun postSecoursJson(
    path: String,
    payload: JSONObject,
    logTag: String,
) {
    fetchSecoursIdToken(
        onSuccess = { idToken ->
            val requestBody = payload.toString()
                .toRequestBody("application/json; charset=utf-8".toMediaType())

            val request = Request.Builder()
                .url(serverBaseUrl + path)
                .addHeader("Authorization", "Bearer $idToken")
                .post(requestBody)
                .build()

            httpClient.newCall(request).enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    Log.e(logTag, "Erreur reseau", e)
                }

                override fun onResponse(call: Call, response: Response) {
                    response.use {
                        Log.d(logTag, "HTTP ${it.code}: ${it.body?.string().orEmpty()}")
                    }
                }
            })
        },
        onError = { error ->
            Log.e(logTag, "Impossible de recuperer le token secours", error)
        },
    )
}
```

Dans MainActivity
-----------------

Pour `sendManualAlert()`, utilise `postSecoursJson("/alert", payload, "ALERTE")`
au lieu de la requete sans header.

Dans LocationForegroundService
-----------------------------

Le service doit aussi envoyer le header `Authorization`.
Avant chaque envoi vers `/update-position`, recupere le Firebase ID token
du compte actuellement connecte, puis ajoute :

```kotlin
.addHeader("Authorization", "Bearer $idToken")
```

Test rapide
-----------

1. creer ou connecter un compte secours dans l'app
2. accorder le role secours avec `POST /grant-secours-access`
3. forcer un refresh du Firebase ID token dans l'app si besoin
4. appeler `GET /auth-check` avec le Bearer token
5. verifier que `/alert` et `/update-position` repondent en `200`

Si `401` :
- token manquant ou invalide

Si `403` :
- compte Firebase valide mais non autorise pour le role secours
