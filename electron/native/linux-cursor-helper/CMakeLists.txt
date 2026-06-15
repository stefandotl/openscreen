cmake_minimum_required(VERSION 3.16)

project(openscreen-linux-cursor-helper LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(PkgConfig REQUIRED)
pkg_check_modules(X11 REQUIRED x11)
pkg_check_modules(XI REQUIRED xi)

add_executable(openscreen-linux-cursor-helper
  src/main.cpp
)

target_include_directories(openscreen-linux-cursor-helper PRIVATE
  ${X11_INCLUDE_DIRS}
  ${XI_INCLUDE_DIRS}
)

target_link_libraries(openscreen-linux-cursor-helper PRIVATE
  ${X11_LIBRARIES}
  ${XI_LIBRARIES}
)

target_compile_options(openscreen-linux-cursor-helper PRIVATE
  -Wall
  -Wextra
  -Wpedantic
)
