---
title: "Anything as a hidden service"
date: "2025-11-14T15:01:00+02:00"
draft: false
post_number: "003"
---

Recently I needed to set up a private Git server. Plain and simple $3 VPS with two Podman containers: one running a Tor daemon for the hidden service, and another one hosting the Git and SSH servers. I thought about writing a post describing the process of setting up something like that, but instead decided to expand the concept from just version control to anything TCP-routed (although you can also route UDP with [tunneling](https://www.whonix.org/wiki/Tunnel_UDP_over_Tor), but that's a completely different topic).

_Why would anyone do this_, you might ask.

1. Anyone using the service can access it anonymously.
2. The server can be fully firewalled from the internet or have a dynamic IP address.

While just the privacy benefits are a big selling point for me, I see the latter reason as more notable for wider audiences. Many consumer ISPs don't offer static IPs for home connections, and even when they do, they're typically way overpriced to be a noteworthy option. Routing all your traffic through a hidden service lets you self-host anything you want from the comfort of your own apartment, because the routing is based on public keys instead of IP addresses. Moving apartments, switching ISPs, or rebooting routers behind CGNAT changes nothing.

## How Tor makes it possible

To understand the logic behind this concept, one must be familiar with how hidden services work. It's pretty common knowledge that Tor wraps its communication into three layers, one for each of the steps in the circuit routing. Still, surprisingly, many don't understand the difference between external and internal circuits, the latter being the case when connecting to hidden services.

To explain the concept, we'll be using following vocabulary (as per the [docs](https://spec.torproject.org/tor-spec/index.html)):

- _Host_ provides the hidden service
- _Client_ connects to the hidden service
- _Hidden service directory_ is a node hosting signed statements of host contact information for clients
- _Introduction point_ is a node picked by host to accept client connection requests and relay them to the host
- _Rendezvous point_ is a node picked by client to be the meeting point with the host, used to relay traffic between the parties without either of them having to reveal their identities to each other

1. Hidden service host picks introduction points and builds individual circuits to them.

![S1](/images/posts/anything-as-hidden-service/s1.svg)

2. Host creates a set of hidden service descriptors and uploads them to hidden service directory (HSDir) nodes.

![S2](/images/posts/anything-as-hidden-service/s2.svg)

3. Client requests the hidden service's introduction point information from one of the hidden service directories (1).
4. Client selects a random rendezvous point and informs the host about this through its introduction point (2).
5. Client and host meet at the rendezvous point (3), get a shared key, and the rendezvous point continues relaying the messages between the client and the server (end-to-end encrypted).

![S3](/images/posts/anything-as-hidden-service/s3.svg)

This procedure results in a 6-hop circuit structure:

```
client <-> guard <-> middle <-> rendezvous <-> middle <-> entry <-> host
```

The key here, considering our goal of being able to accept connections even behind firewalls, are the introduction points. The server makes _outbound_ connections to these nodes and meets any clients at a rendezvous point of their choice by making _outbound_ connections.

With this in mind, you can do something like set your hidden service port to 22 (or ideally something arbitrary to decrease the traffic caused by automated scanners), and direct traffic from there to localhost so that the actual SSH server receives it. Then set your local SSH config to always proxy the connection through the Tor daemon, and you're good to go.

```
# .torrc
HiddenServiceDir <directory>
HiddenServicePort 22 127.0.0.1:22
```

```
# .ssh/config
Host hidden
    HostName example7rmattvz6dev6wr3g5kahgokzdxqnq3vp7hvnwdqzjd7qhsmkqd.onion
    Port 52040
    ProxyCommand nc -x 127.0.0.1:9050 %h %p
```

Beautiful, isn't it?

## Practical and not-so-practical ideas

The throughput of Tor in regards to download and upload speeds is actually quite reasonable, it's the high delay that limits the use cases. Also to be clear, it's not thoughtful to do bandwidth-heavy stuff like torrenting through Tor even if it was capable of that, as it unnecessarily degrades the network's performance for long periods of time.

Here are some applications I thought could potentially fit into this context:

- Homelab SSH without port forwarding
- Version control or file sync without the need to trust someone else's cloud
- Sync for password managers (enhanced with [client authorization](https://community.torproject.org/onion-services/advanced/client-auth/))
- IRC or Jabber bouncers
- RSS aggregators, e-book libraries, etc.
