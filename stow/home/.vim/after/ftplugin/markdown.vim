" vim-polyglot highlights ```lang blocks with regions that end at the first line
" of three or more backticks, whatever the opening fence, so a ````md block
" holding a ``` block closes early and the rest of the file flips between code
" and text. Swap its refresh for regions that end only at a fence at least as
" long as the opening one, as polyglot's untagged blocks already do.
if !exists('#Mkd')
  finish
endif
autocmd! Mkd * <buffer>

" Fence info string -> syntax name. '' leaves the block as plain code, as for
" markdown, whose syntax file cannot be included in itself.
let s:aliases = {
      \ 'c++': 'cpp', 'viml': 'vim', 'bash': 'sh', 'shell': 'sh', 'ini': 'dosini',
      \ 'js': 'javascript', 'ts': 'typescript', 'py': 'python', 'yml': 'yaml',
      \ 'md': '', 'markdown': '',
      \ }

function! s:FenceRegions() abort
  if &syntax !=# 'markdown' || !exists('b:current_syntax')
    return
  endif
  let l:fences = get(b:, 'mkd_fences', {'langs': {}, 'syntaxes': {}})
  let b:mkd_fences = l:fences
  for l:line in getline(1, '$')
    let l:lang = matchstr(l:line, '^\s*\%(`\{3,}\|\~\{3,}\)\s*\zs[0-9A-Za-z_+-]\+')
    if empty(l:lang) || has_key(l:fences.langs, l:lang)
      continue
    endif
    let l:fences.langs[l:lang] = 1
    let l:syntax = tolower(get(s:aliases, l:lang, l:lang))
    if empty(l:syntax) || empty(globpath(&runtimepath, 'syntax/' . l:syntax . '.vim'))
      continue
    endif
    let l:cluster = 'mkdFence_' . substitute(l:syntax, '\W', '_', 'g')
    if !has_key(l:fences.syntaxes, l:syntax)
      let l:fences.syntaxes[l:syntax] = 1
      " Syntax files skip themselves while b:current_syntax is set.
      let l:current = b:current_syntax
      unlet b:current_syntax
      try
        execute 'syntax include @' . l:cluster . ' syntax/' . l:syntax . '.vim'
      finally
        let b:current_syntax = l:current
      endtry
    endif
    let l:group = 'mkdFenceBlock_' . substitute(l:lang, '\W', '_', 'g')
    " The info string must end at the language name: ```py is not ```python.
    " Fences are concealed, as untagged ones are (after/syntax/markdown.vim).
    let l:info = l:lang . '[0-9A-Za-z_+-]\@!.*$'
    for l:fence in ['`', '\~']
      execute printf('syntax region %s matchgroup=mkdCodeStart start=/^\s*\z(%s\{3,}\)\s*%s/'
            \ . ' matchgroup=mkdCodeEnd end=/^\s*\z1%s*\s*$/ keepend concealends contains=@%s',
            \ l:group, l:fence, l:info, l:fence, l:cluster)
    endfor
    execute 'syntax cluster mkdNonListItem add=' . l:group
  endfor
endfunction

augroup mkd_fences
  autocmd! * <buffer>
  " Reloading the syntax clears every region and include, so start over.
  autocmd Syntax <buffer> unlet! b:mkd_fences | call s:FenceRegions()
  " Pick up languages typed since.
  autocmd InsertLeave,BufWritePost,CursorHold <buffer> call s:FenceRegions()
augroup END

" `syntax on` comes before vim-plug's `filetype plugin on`, so the syntax is
" already loaded here.
call s:FenceRegions()
