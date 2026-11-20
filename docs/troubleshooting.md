# Troubleshooting

| Symptom | Action |
| --- | --- |
| Browser storage unavailable | Use HTTPS or localhost, allow site storage and check the [browser requirements](architecture.md#browser-access-and-storage). |
| Embedded API returns 404 | Put the host page under the SDK's base path and call `startTasm()` before using browser `fetch()`. A shell request goes to the static server. |
| Update or reset waits for other tabs | Close the other tabs using this store, then refresh. An update preserves stored media. A reset deletes it. |
| Upload runs out of space | Check available device and site storage, then retry. Clearing site data deletes saved work. |
| Background jobs stop | Reopen a client on the same origin and base path. |
| Build refuses to replace a directory | Choose an empty `TASM_DIST`. Set the same path when serving the build. |

[Report a problem](../SUPPORT.md)
