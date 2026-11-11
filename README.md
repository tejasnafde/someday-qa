# someday-qa

End-to-end QA for [Someday](https://someday.tn07.dev): the production web app
in WebKit at iPhone sizes (Playwright), and the Android and iOS apps on an
emulator and a simulator (Maestro). It runs on GitHub Actions only.

- Run: Actions, workflow "QA", "Run workflow", then pick `web`, `android`,
  `ios` or `all`. A `repository_dispatch` of type `someday-deployed` runs the
  web job.
- Apps: the newest finished EAS builds of the app (an iOS simulator build and
  an APK). Nothing is built here.
- Data: every circle a run makes is named "QA ..." and is deleted after the
  run.
