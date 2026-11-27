-- New tabs start in $HOME. Splits keep Rex's default (source pane's cwd).
-- Opening a folder makes the app create the tab itself, so it also shows it.
rex.action{
  name = "new_home_tab",
  title = "New Tab in Home",
  run = function()
    rex.exec{ "open", "-a", "Rex", os.getenv("HOME") }
  end,
}
rex.bind("cmd+t", "new_home_tab")
