# Broken examples (test fixture)

Used by `doc-examples.test.ts` to prove that a broken example fails the doc example check.

```json frame
{ "v": 1, "type": "input.text", "id": "f1", "ts": 1790000001000,
  "data": { "threadId": "thr_not-a-ulid", "text": "hello" } }
```

```json frame
{ "v": 1, "type": "thread.state", "id": "f2", "ts": 1790000001010,
  "data": { "threadId": "thr_01J8ZQ3K4M5N6P7Q8R9S0T1V31", "state": "thinking" } }
```

```json block
{ "type": "card", "id": "Weather", "title": "Surabaya" }
```

```json block
{ "type": "markdown", "id": "note", "text": "not closed"
```
