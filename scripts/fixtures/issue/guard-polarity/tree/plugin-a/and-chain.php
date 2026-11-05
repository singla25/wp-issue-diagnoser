<?php
if ( function_exists( 'mysql_connect' ) && $ok ) {
	mysql_connect( 'h' );
}
if ( $ok && $more && function_exists( 'mysql_connect' ) ) {
	mysql_connect( 'h' );
}
if ( ! function_exists( 'mysql_connect' ) && $ok ) {
	$x = 1;
} else {
	mysql_connect( 'h' );
}
if ( function_exists( 'mysql_connect' ) and $ok ) {
	mysql_connect( 'h' );
}
