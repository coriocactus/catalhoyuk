" Don't spell-check link text: vim-polyglot's mkdLink region contains @Spell.
syntax match mkdLinkText /[^\]]\+/ contained containedin=mkdLink contains=@NoSpell
highlight default link mkdLinkText htmlLink
